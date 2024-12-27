import os
import json
from flask import Flask, request, jsonify
from PyPDF2 import PdfReader
from langchain.text_splitter import RecursiveCharacterTextSplitter
from langchain_community.vectorstores import FAISS
from langchain_community.embeddings import HuggingFaceEmbeddings
from langchain_google_genai import GoogleGenerativeAIEmbeddings
import google.generativeai as genai
from flask_cors import CORS
from dotenv import load_dotenv

# Workaround to prevent OpenMP error
os.environ["KMP_DUPLICATE_LIB_OK"] = "TRUE"

# Initialize Flask app
app = Flask(__name__)
CORS(app)  # Enable CORS for all routes

# Load environment variables from .env file (for API_KEY and other sensitive details)
load_dotenv()

# Set the environment variable for Google Cloud authentication (use your Service Account JSON file path)
os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = "service-account-key.json"  # Update with your actual file path

# Configuration for Google API Key (Gemini API Key)
API_KEY = os.getenv("MY_API_KEY")  # Ensure your API key is saved in .env
if not API_KEY:
    raise ValueError("API Key is not set. Please add your API Key to the .env file.")
genai.configure(api_key=API_KEY)

# Initialize embedding model (Google Generative AI Embeddings)
embedding_model = GoogleGenerativeAIEmbeddings(model="models/embedding-001")

# Path to PDFs
RULES_PDF_PATH = "Structured-Rules-data.pdf"  # Update with the actual rules PDF path

# Utility Functions
def load_pdf_text(pdf_path):
    """
    Extract text content from a PDF file.
    """
    pdf_reader = PdfReader(pdf_path)
    return "".join([page.extract_text() for page in pdf_reader.pages])

def create_chunks(text):
    """
    Splits text into manageable chunks using a RecursiveCharacterTextSplitter.
    """
    text_splitter = RecursiveCharacterTextSplitter(chunk_size=2000, chunk_overlap=200)
    return [{"text": chunk} for chunk in text_splitter.split_text(text)]

def create_vector_store(rules_text):
    """
    Create a FAISS vector store for the rules.
    """
    rules_chunks = create_chunks(rules_text)
    texts = [chunk["text"] for chunk in rules_chunks]
    metadatas = [{"source": "rules"}] * len(rules_chunks)
    return FAISS.from_texts(texts=texts, embedding=embedding_model, metadatas=metadatas)

def generate_response(prompt):
    """
    Generate a response using the Gemini Pro model.
    """
    model = genai.GenerativeModel("gemini-1.5-pro-002")
    response = model.generate_content(prompt)
    return response.text.strip()

def generate_prompt_from_json(json_data):
    """
    Generate a prompt sentence based on the JSON data.
    Converts the road data into a natural language prompt.
    """
    road_info = []
    parking_status=json_data["parking"]

    if json_data["motorways"]:
        for road in json_data["motorways"]:
            road_info.append(f"Motorway {road} has a lane width of 12m and street parking is {parking_status}.")

    if json_data["aRoads"]:
        for road in json_data["aRoads"]:
            road_info.append(f"A Road {road} has a lane width of 10m and street parking is {parking_status}.")

    if json_data["bRoads"]:
        for road in json_data["bRoads"]:
            road_info.append(f"B Road {road} has a lane width of 5.5m and street parking is {parking_status}.")

    if not road_info:
        return "No road data available to generate a prompt."

    return " ".join(road_info)

# Load rules PDF content and create the vector store
rules_text = load_pdf_text(RULES_PDF_PATH)
vectorstore = create_vector_store(rules_text)

@app.route("/api/create-prompt", methods=["POST"])
def save_road_data():
    """
    API endpoint to save road data sent from the frontend.
    """
    data = request.get_json()
    road_data = data.get("roadData", "")

    if not road_data:
        return jsonify({"error": "Road data is required."}), 400

    print(f"Received road data: {road_data}")  # Debug log

    # Simulate saving road data
    with open("road_data.json", "w") as f:
        f.write(json.dumps(road_data, indent=4))

    return jsonify({"message": "Road data saved successfully."}), 200

@app.route("/query", methods=["POST"])
def query_documents():
    """
    API endpoint to query documents and retrieve responses.
    """
    data = request.get_json()
    query = data.get("query", "")

    if not query:
        return jsonify({"error": "Query is required"}), 400

    print(f"Received query: {query}")  # Debug log

    # Simulate loading road data
    try:
        with open("road_data.json", "r") as f:
            road_data = json.load(f)
    except FileNotFoundError:
        return jsonify({"error": "No road data available."}), 400

    # Generate the prompt from the road data
    prompt = generate_prompt_from_json(road_data)
    print(f"Generated prompt: {prompt}")  # Debug log

    # Retrieve relevant documents
    retriever = vectorstore.as_retriever(search_kwargs={"k": 10})
    relevant_docs = retriever.get_relevant_documents(query)
    combined_text = "\n".join([doc.page_content for doc in relevant_docs])

    if not combined_text.strip():
        return jsonify({"response": "No relevant information found."}), 200

    # Formulate the final prompt
    final_prompt = f"Based on the following information:\n\n{combined_text}\n\nAnd considering the road data:\n\n{prompt}\n\nAnswer the query: {query}"

    # Generate a response using the final prompt
    response_text = generate_response(final_prompt)

    print(f"Response from backend: {response_text}")  # Debug log

    return jsonify({"response": response_text})  # Send the response back to the frontend

if __name__ == "__main__":
    app.run(debug=True, port=8000)

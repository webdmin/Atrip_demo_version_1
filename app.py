import os
import json
from flask import Flask, request, jsonify, render_template
from flask_cors import CORS
from PyPDF2 import PdfReader
from langchain.text_splitter import RecursiveCharacterTextSplitter
from langchain_community.vectorstores import FAISS
from langchain_google_genai import GoogleGenerativeAIEmbeddings
import google.generativeai as genai
from dotenv import load_dotenv
from typing import Dict, List, Any
from dataclasses import dataclass
from collections import defaultdict
import random
import requests

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

# Add new parking data processing functionality
@dataclass
class ParkingSpot:
    id: str
    location: List[float]
    type: str
    capacity: int = 0
    fee: bool = False
    maxstay: str = ""
    disabled_spaces: int = 0
    surface: str = ""
    access: str = "public"

class ParkingDataProcessor:
    def __init__(self):
        self.base_url = 'https:/overpass-api.de/api/interpreter'

    def get_parking_along_route(self, coordinates: List[List[float]], buffer_distance: float = 0.002) -> List[Dict[str, Any]]:
        """
        Fetch parking data along a route with intelligent sampling and filtering.

        Args:
            coordinates: List of [longitude, latitude] points along the route
            buffer_distance: Search radius around each point (in degrees, ~200m)
        """
        parking_data = []
        processed_ids = set()

        # Sample coordinates more densely in urban areas, sparsely in rural
        sampled_coords = self._adaptive_coordinate_sampling(coordinates)

        for coord in sampled_coords:
            bbox = self._calculate_bbox(coord, buffer_distance)
            query = self._build_overpass_query(bbox)

            try:
                response = requests.post(self.base_url, data=query, timeout=30)
                response.raise_for_status()
                data = response.json()

                for element in data.get('elements', []):
                    if element['id'] not in processed_ids:
                        parking_info = self._process_parking_element(element, coord)
                        if parking_info:
                            parking_data.append(parking_info)
                            processed_ids.add(element['id'])

            except requests.exceptions.RequestException as e:
                print(f"Error fetching parking data: {str(e)}")
                continue

        return self._deduplicate_and_merge(parking_data)

    def _adaptive_coordinate_sampling(self, coordinates: List[List[float]]) -> List[List[float]]:
        """Sample coordinates based on route characteristics."""
        sampled = []
        min_distance = 0.002  # Minimum distance between samples (~200m)

        for i, coord in enumerate(coordinates):
            if i == 0 or i == len(coordinates) - 1:
                sampled.append(coord)
                continue

            # Check if we're in an urban area (more coordinates clustered together)
            is_urban = self._is_urban_area(coordinates, i)
            sample_distance = min_distance if is_urban else min_distance * 3

            if not sampled or self._calculate_distance(sampled[-1], coord) >= sample_distance:
                sampled.append(coord)

        return sampled

    def _is_urban_area(self, coordinates: List[List[float]], index: int, window: int = 5) -> bool:
        """Determine if coordinate is in an urban area based on point density."""
        start = max(0, index - window)
        end = min(len(coordinates), index + window)
        segment = coordinates[start:end]

        if len(segment) < 3:
            return False

        # Calculate average distance between points
        distances = []
        for i in range(len(segment) - 1):
            distances.append(self._calculate_distance(segment[i], segment[i + 1]))

        avg_distance = sum(distances) / len(distances)
        return avg_distance < 0.001  # Threshold for urban area

    def _calculate_distance(self, coord1: List[float], coord2: List[float]) -> float:
        """Calculate simple Euclidean distance between coordinates."""
        return ((coord1[0] - coord2[0]) ** 2 + (coord1[1] - coord2[1]) ** 2) ** 0.5

    def _calculate_bbox(self, coord: List[float], buffer: float) -> List[float]:
        """Calculate bounding box around coordinate."""
        return [
            coord[0] - buffer,  # min lon
            coord[1] - buffer,  # min lat
            coord[0] + buffer,  # max lon
            coord[1] + buffer   # max lat
        ]

    def _build_overpass_query(self, bbox: List[float]) -> str:
        """Build Overpass API query for parking data."""
        return f"""
        [out:json][timeout:25];
        (
            way({bbox[1]},{bbox[0]},{bbox[3]},{bbox[2]})["amenitys"="parkings"];
            way({bbox[1]},{bbox[0]},{bbox[3]},{bbox[2]})["parkings"];
            way({bbox[1]},{bbox[0]},{bbox[3]},{bbox[2]})["parkings:lanes"];
        );
        out body;
        >;
        out skel qt;
        """

    def _process_parking_element(self, element: Dict, coord: List[float]) -> Dict[str, Any]:
        """Process raw parking element into structured format."""
        tags = element.get('tags', {})

        if not any(key in tags for key in ['amenity', 'parking', 'parking:lane']):
            return None

        return {
            'id': str(element['id']),
            'location': [
                element.get('center', {}).get('lon', coord[0]),
                element.get('center', {}).get('lat', coord[1])
            ],
            'type': element['type'],
            'parking': {
                'type': tags.get('parkings') or tags.get('amenity'),
                'access': tags.get('access', 'public'),
                'fee': tags.get('parking:fee') or tags.get('fee', 'no'),
                'maxstay': tags.get('parking:maxstay') or tags.get('maxstay', ''),
                'capacity': tags.get('capacity', ''),
                'disabled': tags.get('capacity:disabled', ''),
                'surface': tags.get('surface', ''),
                'lanes': {
                    'left': tags.get('parkings:lane:left', ''),
                    'right': tags.get('parkings:lane:right', ''),
                    'both': tags.get('parkings:lane:both', '')
                }
            }
        }

    def _deduplicate_and_merge(self, parking_data: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """Deduplicate parking spots and merge nearby duplicates."""
        merged = defaultdict(list)

        # Group by location (rounded to 5 decimal places)
        for spot in parking_data:
            key = (
                round(spot['location'][0], 5),
                round(spot['location'][1], 5)
            )
            merged[key].append(spot)

        # Merge spots at the same location
        result = []
        for spots in merged.values():
            if len(spots) == 1:
                result.append(spots[0])
            else:
                result.append(self._merge_parking_spots(spots))

        return result

    def _merge_parking_spots(self, spots: List[Dict[str, Any]]) -> Dict[str, Any]:
        """Merge multiple parking spots at the same location."""
        base = spots[0].copy()

        # Merge parking details
        for spot in spots[1:]:
            for key, value in spot['parking'].items():
                if value and not base['parking'][key]:
                    base['parking'][key] = value

        return base

# Add this function after the existing imports:
def get_parking_data(coordinates: List[List[float]]) -> List[Dict]:
    """
    Fetch parking data along a route using Overpass API
    """
    parking_data = []
    buffer = 0.002  # Roughly 200 meters buffer around the route

    # Sample coordinates to reduce API calls (take every 5th coordinate)
    sampled_coords = coordinates[::5]

    for coord in sampled_coords:
        bbox = [
            coord[0] - buffer,  # min lon
            coord[1] - buffer,  # min lat
            coord[0] + buffer,  # max lon
            coord[1] + buffer   # max lat
        ]

        # Overpass query for parking facilities
        query = f"""
        [out:json][timeout:25];
        (
            way({bbox[1]},{bbox[0]},{bbox[3]},{bbox[2]})["amenity"="parking"];
            way({bbox[1]},{bbox[0]},{bbox[3]},{bbox[2]})["parking"];
            way({bbox[1]},{bbox[0]},{bbox[3]},{bbox[2]})["parking:lane"];
        );
        out body;
        >;
        out skel qt;
        """

        try:
            response = requests.post('https://overpass-api.de/api/interpreter', data=query)
            data = response.json()

            for element in data.get('elements', []):
                if element.get('tags'):
                    parking_info = {
                        'id': element['id'],
                        'location': [
                            element.get('center', {}).get('lon', coord[0]),
                            element.get('center', {}).get('lat', coord[1])
                        ],
                        'type': element['type'],
                        'tags': element['tags'],
                        'parking': {
                            'type': element['tags'].get('parking'),
                            'access': element['tags'].get('access'),
                            'fee': element['tags'].get('parking:fee') or element['tags'].get('fee'),
                            'maxstay': element['tags'].get('parking:maxstay'),
                            'capacity': element['tags'].get('capacity'),
                            'disabled': element['tags'].get('capacity:disabled'),
                            'surface': element['tags'].get('surface'),
                            'lanes': {
                                'left': element['tags'].get('parking:lane:left'),
                                'right': element['tags'].get('parking:lane:right'),
                                'both': element['tags'].get('parking:lane:both')
                            }
                        }
                    }

                    # Avoid duplicate entries
                    if not any(p['id'] == parking_info['id'] for p in parking_data):
                        parking_data.append(parking_info)
        except Exception as e:
            print(f"Error fetching parking data: {str(e)}")
            continue

    return parking_data

# Utility Functions
def load_pdf_text(pdf_path):
    """
    Extract text content from a PDF file.
    """
    pdf_reader = PdfReader(pdf_path)
    return "".join([page.extract_text() for page in pdf_reader.pages])

def create_chunks(text):
    """
    Split text into manageable chunks using a RecursiveCharacterTextSplitter.
    """
    text_splitter = RecursiveCharacterTextSplitter(chunk_size=2000, chunk_overlap=200)
    return [{"text": chunk} for chunk in text_splitter.split_text(text)]

def create_vector_store(rules_text):
    """
    Create a FAISS vector store for the rules.
    """
    rules_chunks = create_chunks(rules_text)
    texts = [chunk["text"] for chunk in rules_chunks]
    return FAISS.from_texts(texts=texts, embedding=embedding_model)

def generate_response(prompt):
    """
    Generate a response using the Gemini Pro model.
    """
    model = genai.GenerativeModel("gemini-1.5-pro-002")
    response = model.generate_content(prompt)
    return response.text.strip()

def get_road_details(road_name: str, road_data: Dict) -> Dict:
    """Get detailed configuration for a road based on its type."""
    return {
        'name': road_name,
        'width': road_data.get('width', 0),
        'cycle_path': road_data.get('cycle_path', False),
        'parking': road_data.get('parking', False),
        'speed_limit': road_data.get('speed_limit', 0)
    }

def generate_prompt_from_json(json_data: Dict) -> str:
    """Generate comprehensive prompt from road data."""
    all_roads = []

    # Process each road type
    if json_data.get('motorways'):
        all_roads.extend([get_road_details(road, json_data['motorways'][road]) for road in json_data['motorways']])
    if json_data.get('aRoads'):
        all_roads.extend([get_road_details(road, json_data['aRoads'][road]) for road in json_data['aRoads']])
    if json_data.get('bRoads'):
        all_roads.extend([get_road_details(road, json_data['bRoads'][road]) for road in json_data['bRoads']])

    # Generate prompt sections for each road
    prompt_sections = []
    for road in all_roads:
        section = (
            f"{road['name']} has a lane width of {road['width']}m and "
            f"{'has' if road['parking'] else 'does not have'} street parking. "
            f"Speed limit is {road['speed_limit']}mph."
            f"{'It includes a cycle path.' if road['cycle_path'] else ''}"
        )
        prompt_sections.append(section)

    return " ".join(prompt_sections)


def generate_report(road_data: dict) -> dict:
    raw_data = []
    for road_type in ['motorways', 'aRoads', 'bRoads']:
        for road in road_data.get(road_type, []):
            raw_data.append(get_road_details(road, road_data[road_type][road]))

    return {
        'majorRoads': {
            'motorways': sorted(road_data['motorways']),
            'aRoads': sorted(road_data['aRoads']),
            'bRoads': sorted(road_data['bRoads'])
        },
        'rawData': raw_data,
        'streetParkingAvailable': len(road_data['aRoads']) > 0,
        'totalMajorRoads': len(road_data['motorways']) + len(road_data['aRoads']) + len(road_data['bRoads'])
    }

def generate_parking_prompt(parking_data):
    """Generate a structured prompt from parking data"""
    parking_summary = []

    for i, spot in enumerate(parking_data, 1):
        details = []
        p = spot.get('parking', {})

        if p.get('type'):
            details.append(f"Type: {p['type']}")
        if p.get('access'):
            details.append(f"Access: {p['access']}")
        if p.get('fee'):
            details.append(f"Fee: {p['fee']}")
        if p.get('maxstay'):
            details.append(f"Maximum stay: {p['maxstay']}")

        parking_summary.append(f"Parking Spot {i}: {', '.join(details)}")

    return "\n".join(parking_summary)

def summarize_route(route_data):
    """Generate a concise summary of route data"""
    return {
        "total_roads": len(route_data.get('motorways', [])) +
                      len(route_data.get('aRoads', [])) +
                      len(route_data.get('bRoads', [])),
        "road_types": {
            "motorways": len(route_data.get('motorways', [])),
            "aRoads": len(route_data.get('aRoads', [])),
            "bRoads": len(route_data.get('bRoads', []))
        }
    }

def summarize_parking(parking_data):
    """Generate a concise summary of parking data"""
    return {
        "total_spots": len(parking_data),
        "types": {
            "parallel": sum(1 for p in parking_data if p.get('parking', {}).get('type') == 'parallel'),
            "surface": sum(1 for p in parking_data if p.get('parking', {}).get('type') == 'surface'),
            "other": sum(1 for p in parking_data if p.get('parking', {}).get('type') not in ['parallel', 'surface'])
        }
    }

# Load rules PDF content and create the vector store
rules_text = load_pdf_text(RULES_PDF_PATH)
vectorstore = create_vector_store(rules_text)

@app.route('/')
def index():
    return render_template('index.html')

if __name__ == "__main__":
    app.run(debug=True, port=5000)
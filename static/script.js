class RoadScanner {
    constructor() {
        // Previous initialization code remains the same
        this.routes = [];
        this.activeRoute = null;
        this.parkingCount = 1;

        // Initialize Mapbox map
        mapboxgl.accessToken = 'pk.eyJ1Ijoia2F2aWt1bWFyYW4iLCJhIjoiY2xqcmRlbDJ0MDA4eTNzbnV3Z2Z0YW9pZyJ9.p4QVPDyldRLRS1yCUIH0-Q';
        this.map = new mapboxgl.Map({
            container: 'map',
            style: 'mapbox://styles/mapbox/streets-v11',
            center: [-1.9018, 52.4862],
            zoom: 10
        });

        // Initialize other properties
        this.originMarker = null;
        this.destinationMarker = null;
        this.currentRouteData = null;
        this.routeGeometry = null;
        this.routeSteps = null;
        this.parkingMarkers = [];
        this.selectedParking = null;
        this.allParkingData = [];

        // Initialize route analysis data
        this.routeAnalysis = {
            lanes: [],
            parking: [],
            maxSpeed: []
        };

        // Setup initial components
        this.map.addControl(new mapboxgl.NavigationControl());
        this.initializeParkingLegend();
        this.setupEventListeners();
        this.setupChatEventListeners();
        this.initializeChatbot();
        this.addRawDataButton();
        this.addStyles();
    }

    initializeParkingLegend() {
        const legend = document.createElement('div');
        legend.className = 'parking-legend';
        legend.innerHTML = `
            <h6>Parking Legend</h6>
            <div class="legend-item">
                <div class="marker-dot no-parking"></div>
                <span>No Parking</span>
            </div>
            <div class="legend-item">
                <div class="marker-dot parallel-parking"></div>
                <span>Parallel Parking</span>
            </div>
            <div class="legend-item">
                <div class="marker-dot other-parking"></div>
                <span>Other Parking</span>
            </div>
        `;
        document.querySelector('#map').appendChild(legend);
    }

    setupEventListeners() {
        document.getElementById('scan-btn').addEventListener('click', () => this.scanArea());
        ['origin', 'destination'].forEach(id => {
            const element = document.getElementById(id);
            element.addEventListener('input', (e) => {
                e.target.value = e.target.value.replace(/[^a-zA-Z0-9\s,]/g, '');
            });
            element.addEventListener('keypress', (e) => {
                if (e.key === 'Enter') this.scanArea();
            });
        });
    }

    setupChatEventListeners() {
        const sendButton = document.getElementById('send-message');
        const chatInput = document.getElementById('chat-input');

        sendButton.addEventListener('click', () => this.sendMessage());
        chatInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') this.sendMessage();
        });

        chatInput.disabled = true;
        sendButton.disabled = false;
    }

    async sendMessage() {
        const chatInput = document.getElementById('chat-input');
        const message = chatInput.value.trim();

        if (!message || !this.currentRouteData) {
            !this.currentRouteData && this.addMessageToChat('Please scan a route first!', 'bot');
            return;
        }

        this.addMessageToChat(message, 'user');
        chatInput.value = '';

        try {
            const response = await fetch('http://127.0.0.1:8000/query', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    query: message
                })
            });

            if (!response.ok) throw new Error('Server response error');

            const data = await response.json();
            this.addMessageToChat(this.formatChatResponse(data.response), 'bot'); // Format the response

        } catch (error) {
            console.error('Chat Error:', error);
            this.addMessageToChat('Sorry, I encountered an error. Please try again.', 'bot');
        }
    }

    formatChatResponse(response) {
        // Remove unwanted ** characters and format the response
        response = response.replace(/\*\*/g, '');
        response = response.replace(/\n/g, '<br>');
        response = response.replace(/\* (.+?):/g, '<strong>$1:</strong>');
        response = response.replace(/\* Conclusion:/g, '<strong>Conclusion:</strong>');
        response = response.replace(/\* Option \d+:/g, '<strong>Option $&</strong>');
        return response;
    }

    async getParkingAlongRoute(coordinates) {
        const parkingData = [];
        const buffer = 0.002; // Roughly 200 meters
        const sampledCoords = coordinates.filter((_, i) => i % 5 === 0);

        for (const coord of sampledCoords) {
            const bbox = [
                coord[0] - buffer,
                coord[1] - buffer,
                coord[0] + buffer,
                coord[1] + buffer
            ];

            const query = `
                [out:json][timeout:25];
                (
                    way(${bbox[1]},${bbox[0]},${bbox[3]},${bbox[2]})["amenity"="parking"];
                    way(${bbox[1]},${bbox[0]},${bbox[3]},${bbox[2]})["parking"];
                    way(${bbox[1]},${bbox[0]},${bbox[3]},${bbox[2]})["parking:lane"];
                );
                out body;
                >;
                out skel qt;
            `;

            try {
                const response = await fetch('https:/overpass-api.de/api/interpreter', {
                    method: 'POST',
                    body: query
                });

                const data = await response.json();

                for (const element of data.elements) {
                    if (element.tags) {
                        const parkingInfo = this.createParkingInfo(element, coord);
                        if (!parkingData.some(p => p.id === parkingInfo.id)) {
                            parkingData.push(parkingInfo);
                        }
                    }
                }
            } catch (error) {
                console.error('Error fetching parking data:', error);
            }
        }

        return parkingData;
    }

    createParkingInfo(element, coord) {
        return {
            id: element.id,
            location: [
                element.center ? element.center.lon : coord[0],
                element.center ? element.center.lat : coord[1]
            ],
            type: element.type,
            tags: element.tags,
            amenity: element.tags.amenity,
            parking: {
                type: element.tags.parking,
                access: element.tags.access,
                fee: element.tags['parking:fee'] || element.tags.fee,
                maxstay: element.tags['parking:maxstay'],
                capacity: element.tags.capacity,
                disabled: element.tags['capacity:disabled'],
                surface: element.tags.surface,
                lanes: {
                    left: element.tags['parking:lane:left'],
                    right: element.tags['parking:lane:right'],
                    both: element.tags['parking:lane:both']
                }
            }
        };
    }

    getParkingColor(parking) {
        if (parking.access === 'no' || parking.type === 'no_parking') {
            return '#dc3545'; // Red for no parking
        } else if (parking.lanes.left === 'parallel' ||
                  parking.lanes.right === 'parallel' ||
                  parking.type === 'lane') {
            return '#0d6efd'; // Blue for parallel parking
        }
        return '#198754'; // Green for other parking types
    }

    createParkingPopupContent(data, index) {
        return `
            <div class="parking-popup">
                <h6>Parking ${index + 1}</h6>
                ${this.createParkingDetailsHTML(data.parking)}
            </div>
        `;
    }

    createParkingDetailsHTML(parking) {
        let html = '<div class="parking-details">';

        if (parking.type) {
            html += `<p><strong>Type:</strong> ${parking.type}</p>`;
        }
        if (parking.access) {
            html += `<p><strong>Access:</strong> ${parking.access}</p>`;
        }
        if (parking.fee) {
            html += `<p><strong>Fee:</strong> ${parking.fee}</p>`;
        }
        if (parking.maxstay) {
            html += `<p><strong>Max Stay:</strong> ${parking.maxstay}</p>`;
        }
        if (parking.capacity) {
            html += `<p><strong>Capacity:</strong> ${parking.capacity}</p>`;
        }
        if (parking.disabled) {
            html += `<p><strong>Disabled Spots:</strong> ${parking.disabled}</p>`;
        }
        if (parking.surface) {
            html += `<p><strong>Surface:</strong> ${parking.surface}</p>`;
        }

        if (parking.lanes.left || parking.lanes.right || parking.lanes.both) {
            html += '<div class="lanes-info">';
            html += '<p><strong>Parking Lanes:</strong></p>';
            if (parking.lanes.left) html += `<p>Left: ${parking.lanes.left}</p>`;
            if (parking.lanes.right) html += `<p>Right: ${parking.lanes.right}</p>`;
            if (parking.lanes.both) html += `<p>Both: ${parking.lanes.both}</p>`;
            html += '</div>';
        }

        html += '</div>';
        return html;
    }

    async scanArea() {
        const origin = document.getElementById('origin').value.trim();
        const destination = document.getElementById('destination').value.trim();

        if (!origin || !destination) {
            this.showAlert('Please enter both origin and destination.');
            return;
        }

        try {
            this.showLoadingState(true);
            this.clearMap();

            const [originCoords, destCoords] = await Promise.all([
                this.geocode(origin),
                this.geocode(destination)
            ]);

            const routes = await this.getDirectionsRoute(originCoords, destCoords);
            this.routes = routes;

            this.updateMarkers(originCoords, destCoords);
            this.drawRoute(routes);

            // Set first route as active by default
            this.setActiveRoute(0, routes[0]);

            const parkingData = await this.getParkingAlongRoute(routes[0].geometry.coordinates);
            this.allParkingData = parkingData;

            await this.addParkingMarkers(parkingData);
            this.updateParkingList(parkingData);
            this.fitMapToRoute(routes[0].geometry.coordinates);

            this.enableChat();
            this.showLoadingState(false);

        } catch (error) {
            console.error('Scan Area Error:', error);
            this.showLoadingState(false);
            this.showAlert(error.message);
        }
    }

    async geocode(location) {
        try {
            const response = await fetch(
                `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(location)}.json?country=GB&limit=1&access_token=${mapboxgl.accessToken}`
            );

            if (!response.ok) {
                throw new Error('Geocoding API request failed');
            }

            const data = await response.json();
            if (!data.features || !data.features.length) {
                throw new Error(`Location not found: ${location}`);
            }

            return data.features[0].center;
        } catch (error) {
            console.error('Geocoding error:', error);
            throw new Error(`Failed to find location: ${location}`);
        }
    }

    async getDirectionsRoute(origin, destination) {
        try {
            const response = await fetch(
                `https://api.mapbox.com/directions/v5/mapbox/driving/${origin[0]},${origin[1]};${destination[0]},${destination[1]}?geometries=geojson&steps=true&alternatives=true&annotations=maxspeed,congestion&overview=full&access_token=${mapboxgl.accessToken}`
            );

            if (!response.ok) {
                throw new Error('Directions API request failed');
            }

            const data = await response.json();
            if (!data.routes || !data.routes.length) {
                throw new Error('No route found');
            }

            return data.routes;
        } catch (error) {
            console.error('Directions error:', error);
            throw new Error('Failed to get route directions');
        }
    }

    extractRoadRefs(instruction) {
        const refs = {
            motorways: new Set(),
            aRoads: new Set(),
            bRoads: new Set()
        };

        const patterns = {
            motorway: /\b[M][0-9]+(?:\([M]?[0-9]+\))?\b|\bM[0-9]+\b/g,
            aRoad: /\b[A][0-9]+(?:\([A]?[0-9]+\))?\b|\bA[0-9]+\b/g,
            bRoad: /\b[B][0-9]+(?:\([B]?[0-9]+\))?\b|\bB[0-9]+\b/g
        };

        const motorwayMatches = instruction.match(patterns.motorway) || [];
        const aRoadMatches = instruction.match(patterns.aRoad) || [];
        const bRoadMatches = instruction.match(patterns.bRoad) || [];

        motorwayMatches.forEach(ref => refs.motorways.add(ref.toUpperCase()));
        aRoadMatches.forEach(ref => refs.aRoads.add(ref.toUpperCase()));
        bRoadMatches.forEach(ref => refs.bRoads.add(ref.toUpperCase()));

        return refs;
    }

    processRouteData(route) {
        const roadRefs = {
            motorways: new Set(),
            aRoads: new Set(),
            bRoads: new Set()
        };

        route.legs[0].steps.forEach(step => {
            const refs = this.extractRoadRefs(step.maneuver.instruction);
            const nameRefs = this.extractRoadRefs(step.name || '');

            Object.keys(refs).forEach(type => {
                refs[type].forEach(ref => roadRefs[type].add(ref));
                nameRefs[type].forEach(ref => roadRefs[type].add(ref));
            });

            if (step.annotation) {
                this.routeAnalysis.maxSpeed.push(step.annotation.maxspeed || null);
                this.routeAnalysis.lanes.push(step.annotation.lanes || null);
            }
        });

        const hasParking = roadRefs.aRoads.size > 0;

        return {
            motorways: Array.from(roadRefs.motorways),
            aRoads: Array.from(roadRefs.aRoads),
            bRoads: Array.from(roadRefs.bRoads),
            parking: hasParking ? "available" : "not available"
        };
    }

    clearMap() {
        this.parkingMarkers.forEach(marker => marker.remove());
        this.parkingMarkers = [];
        if (this.originMarker) {
            this.originMarker.remove();
            this.originMarker = null;
        }
        if (this.destinationMarker) {
            this.destinationMarker.remove();
            this.destinationMarker = null;
        }
        if (this.map.getSource('route')) {
            this.map.removeLayer('route');
            this.map.removeSource('route');
        }
    }

    async addParkingMarkers(parkingData) {
        this.clearParkingMarkers();
        this.parkingCount = 1;

        parkingData.forEach((data, index) => {
            const el = document.createElement('div');
            el.className = 'marker';
            el.style.backgroundColor = this.getParkingColor(data.parking);
            el.innerHTML = `<span style="color: white; font-weight: bold;">${index + 1}</span>`;
            el.style.display = 'flex';
            el.style.justifyContent = 'center';
            el.style.alignItems = 'center';
            el.style.width = '24px';
            el.style.height = '24px';

            const marker = new mapboxgl.Marker(el)
                .setLngLat(data.location)
                .setPopup(
                    new mapboxgl.Popup({ offset: 25 })
                        .setHTML(this.createParkingPopupContent(data, index + 1))
                )
                .addTo(this.map);

            marker.getElement().addEventListener('click', () => {
                this.displaySelectedParking(data, index + 1);
            });

            this.parkingMarkers.push(marker);
        });
    }

    clearParkingMarkers() {
        this.parkingMarkers.forEach(marker => marker.remove());
        this.parkingMarkers = [];
    }

    displaySelectedParking(data, index) {
        const container = document.getElementById('parking-info');
        container.innerHTML = this.createParkingDetailsHTML(data.parking);
        this.selectedParking = data;
    }

    drawRoute(routes) {
        // Clear existing routes
        routes.forEach((_, index) => {
            if (this.map.getSource(`route-${index}`)) {
                this.map.removeLayer(`route-${index}`);
                this.map.removeSource(`route-${index}`);
            }
        });

        // Draw each route
        routes.forEach((route, index) => {
            this.map.addSource(`route-${index}`, {
                type: 'geojson',
                data: {
                    type: 'Feature',
                    properties: {},
                    geometry: route.geometry
                }
            });

            this.map.addLayer({
                id: `route-${index}`,
                type: 'line',
                source: `route-${index}`,
                layout: {
                    'line-join': 'round',
                    'line-cap': 'round'
                },
                paint: {
                    'line-color': '#3887be',
                    'line-width': 5,
                    'line-opacity': 0.75
                }
            });

            // Add hover and click interactions
            this.map.on('mouseenter', `route-${index}`, () => {
                this.map.getCanvas().style.cursor = 'pointer';
                this.map.setPaintProperty(`route-${index}`, 'line-opacity', 1);
            });

            this.map.on('mouseleave', `route-${index}`, () => {
                this.map.getCanvas().style.cursor = '';
                if (this.activeRoute !== index) {
                    this.map.setPaintProperty(`route-${index}`, 'line-opacity', 0.75);
                }
            });

            this.map.on('click', `route-${index}`, () => {
                this.setActiveRoute(index, route);
            });
        });
    }

    // Add method to handle active route selection
    setActiveRoute(index, route) {
        // Reset opacity for all routes
        this.routes.forEach((_, i) => {
            this.map.setPaintProperty(`route-${i}`, 'line-opacity', 0.75);
            this.map.setPaintProperty(`route-${i}`, 'line-width', 5);
        });

        // Highlight selected route
        this.map.setPaintProperty(`route-${index}`, 'line-opacity', 1);
        this.map.setPaintProperty(`route-${index}`, 'line-width', 8);

        this.activeRoute = index;
        this.currentRouteData = this.processRouteData(route);
        this.updateUI(this.currentRouteData);
        this.updateRawDataPanel();

        // Send road data to the backend
        this.saveRoadDataToBackend(this.currentRouteData);

        // Display parking information for the selected route
        this.displayParkingInfoForRoute(route.geometry.coordinates);
    }

    async displayParkingInfoForRoute(coordinates) {
        const parkingData = await this.getParkingAlongRoute(coordinates);
        this.updateParkingList(parkingData);
        await this.addParkingMarkers(parkingData);
    }

    updateUI(roads) {
        // Update road lists with badges
        document.getElementById('motorways-list').innerHTML = Array.from(roads.motorways)
            .sort()
            .map(road => `<span class="road-badge bg-primary">${road}</span>`)
            .join('');

        document.getElementById('aroads-list').innerHTML = Array.from(roads.aRoads)
            .sort()
            .map(road => `<span class="road-badge bg-success">${road}</span>`)
            .join('');

        document.getElementById('broads-list').innerHTML = Array.from(roads.bRoads)
            .sort()
            .map(road => `<span class="road-badge bg-warning text-dark">${road}</span>`)
            .join('');

        // Update statistics
        const totalRoads = roads.motorways.length + roads.aRoads.length + roads.bRoads.length;
        document.getElementById('road-stats').innerHTML = `
            <table class="table table-sm">
                <tr>
                    <td>Total Major Roads:</td>
                    <td>${totalRoads}</td>
                </tr>
                <tr>
                    <td>Motorways:</td>
                    <td>${roads.motorways.length}</td>
                </tr>
                <tr>
                    <td>A Roads:</td>
                    <td>${roads.aRoads.length}</td>
                </tr>
                <tr>
                    <td>B Roads:</td>
                    <td>${roads.bRoads.length}</td>
                </tr>
                <tr>
                    <td>Street Parking:</td>
                    <td>${roads.parking}</td>
                </tr>
            </table>
        `;
    }

    updateMarkers(origin, destination) {
        if (this.originMarker) this.originMarker.remove();
        if (this.destinationMarker) this.destinationMarker.remove();

        this.originMarker = new mapboxgl.Marker({ color: '#00ff00' })
            .setLngLat(origin)
            .addTo(this.map);

        this.destinationMarker = new mapboxgl.Marker({ color: '#ff0000' })
            .setLngLat(destination)
            .addTo(this.map);
    }

    addMessageToChat(message, type) {
        const chatMessages = document.getElementById('chat-messages');
        const messageDiv = document.createElement('div');
        messageDiv.className = `message ${type}-message`;
        messageDiv.innerHTML = message;
        chatMessages.appendChild(messageDiv);
        chatMessages.scrollTop = chatMessages.scrollHeight;
    }

    showLoadingState(isLoading) {
        const scanBtn = document.getElementById('scan-btn');
        scanBtn.disabled = isLoading;
        scanBtn.innerHTML = isLoading ?
            '<span class="spinner-border spinner-border-sm" role="status" aria-hidden="true"></span> Scanning...' :
            'Scan Roads';
    }

    showAlert(message) {
        const alertDiv = document.createElement('div');
        alertDiv.className = 'alert alert-danger alert-dismissible fade show';
        alertDiv.innerHTML = `
            ${message}
            <button type="button" class="btn-close" data-bs-dismiss="alert"></button>
        `;
        document.querySelector('.scan-area').prepend(alertDiv);
    }

    enableChat() {
        document.getElementById('chat-input').disabled = false;
        document.getElementById('send-message').disabled = false;
        this.addMessageToChat('Route analyzed! You can now ask me about the roads and parking options.', 'bot');
        this.showLoadingState(false);
    }

    // New methods for raw data panel
    addStyles() {
        const styleSheet = document.createElement("style");
        styleSheet.textContent = `
            .raw-data-panel {
                position: fixed;
                bottom: 60px;
                left: 20px;
                background: white;
                padding: 15px;
                border-radius: 8px;
                box-shadow: 0 2px 10px rgba(0,0,0,0.1);
                max-width: 400px;
                display: none;
                z-index: 1000;
                max-height: 80vh;
                overflow-y: auto;
            }

            .raw-data-button {
                position: fixed;
                bottom: 20px;
                left: 20px;
                z-index: 1000;
            }

            .route-hover {
                cursor: pointer;
                opacity: 0.8;
            }

            .route-active {
                opacity: 1;
                width: 8px !important;
            }
        `;
        document.head.appendChild(styleSheet);
    }

    addRawDataButton() {
        // Add button
        const button = document.createElement('button');
        button.className = 'btn btn-primary raw-data-button';
        button.innerHTML = 'Show Raw Data';
        document.body.appendChild(button);

        // Add panel
        const panel = document.createElement('div');
        panel.className = 'raw-data-panel';
        document.body.appendChild(panel);

        // Toggle functionality
        let isVisible = false;
        button.addEventListener('click', () => {
            isVisible = !isVisible;
            panel.style.display = isVisible ? 'block' : 'none';
            button.innerHTML = isVisible ? 'Hide Raw Data' : 'Show Raw Data';
            if (isVisible && this.currentRouteData) {
                this.updateRawDataPanel();
            }
        });
    }

    updateRawDataPanel() {
        const panel = document.querySelector('.raw-data-panel');
        const data = this.currentRouteData;

        if (!data) {
            panel.innerHTML = '<p>No route data available. Please scan a route first.</p>';
            return;
        }

        const roadData = this.processRawData();
        panel.innerHTML = `
            <h5>Raw Route Data</h5>
            <div class="table-responsive">
                <table class="table table-sm">
                    <thead>
                        <tr>
                            <th>Road</th>
                            <th>Speed Limit</th>
                            <th>Lanes</th>
                            <th>Parking</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${roadData.map(road => `
                            <tr>
                                <td>${road.name}</td>
                                <td>${road.maxSpeed || 'N/A'} mph</td>
                                <td>${road.lanes || 'N/A'}</td>
                                <td>${road.parking ? 'Yes' : 'No'}</td>
                            </tr>
                        `).join('')}
                    </tbody>
                </table>
            </div>
        `;
    }

    processRawData() {
        const data = this.currentRouteData;
        const processedData = [];

        // Process Motorways
        data.motorways.forEach(road => {
            processedData.push({
                name: road,
                maxSpeed: 70,
                lanes: '3',
                parking: false
            });
        });

        // Process A Roads
        data.aRoads.forEach(road => {
            processedData.push({
                name: road,
                maxSpeed: this.routeAnalysis.maxSpeed[processedData.length] || 60,
                lanes: this.routeAnalysis.lanes[processedData.length] || '2',
                parking: true
            });
        });

        // Process B Roads
        data.bRoads.forEach(road => {
            processedData.push({
                name: road,
                maxSpeed: this.routeAnalysis.maxSpeed[processedData.length] || 40,
                lanes: this.routeAnalysis.lanes[processedData.length] || '1',
                parking: true
            });
        });

        return processedData;
    }

    initializeChatbot() {
        this.addMessageToChat('Welcome! Please scan a route to begin analyzing road data. You can ask me about:', 'bot');
        this.addMessageToChat('- Motorways on the route\n- A-Roads and B-Roads\n- Parking availability\n- General route information', 'bot');
    }

    updateParkingList(parkingData) {
        const parkingList = document.getElementById('parking-list');
        if (parkingList) {
            parkingList.innerHTML = parkingData.map((parking, index) => `
                <div class="parking-item">
                    <strong>Parking ${index + 1}</strong>
                    <p>${parking.parking.type || 'General Parking'}</p>
                </div>
            `).join('');
        } else {
            console.error('Parking list element not found');
        }
    }

    fitMapToRoute(coordinates) {
        const bounds = coordinates.reduce((bounds, coord) => {
            return bounds.extend(coord);
        }, new mapboxgl.LngLatBounds(coordinates[0], coordinates[0]));

        this.map.fitBounds(bounds, {
            padding: { top: 50, bottom: 50, left: 450, right: 50 },
            duration: 1000
        });
    }

    async saveRoadDataToBackend(roadData) {
        try {
            const response = await fetch('http://127.0.0.1:8000/api/create-prompt', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    roadData: roadData
                })
            });

            if (!response.ok) throw new Error('Server response error');

            const data = await response.json();
            console.log(data.message); // Log the message from the backend

        } catch (error) {
            console.error('Error saving road data:', error);
        }
    }
}

// Initialize the application when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    new RoadScanner();
});
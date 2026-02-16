/**
 * NYC Subway Live Tracker Demo
 * 
 * This application demonstrates how to build a high-fidelity real-time digital twin of 
 * New York City's subway lines using CesiumJS, Cesium World Terrain, a custom photogrammetry model, 
 * custom shaders, and real-time data feeds provided by Metropolitan Transportation Authority (MTA).
 */

// We initialize the token as empty. It will be fetched securely from our backend 
// to avoid exposing sensitive keys in the client-side source code.
Cesium.Ion.defaultAccessToken = '';

const appState = {
    isLoaded: false,
    isUpdating: false, // Mutex lock to prevent overlapping network requests
    
    viewer: null,
    
    // 3D Assets
    tileset_customModel: null,
    tileset_nycBuildings: null,
    hiddenBuildings: [],

    // Subway Line Data
    subwayLinesData: null,
    routeMap: {},
    flattenedRouteMap: {},
    hiddenLines: new Set(),
    
    // Train Tracking
    trainEntities: {},
    lastKnownCoords: {},
    lastSeenTimes: {},
    polylineCollection: null,

    // UI Elements
    ui: {
        resetViewButton: null,
        topdownViewButton: null,
        toggleModelButton: null
    }
};

// --- Button Handler Functions ---

// Resets the camera to the default view
function flyToHome() {
    appState.viewer.camera.flyTo({
        destination: Cesium.Cartesian3.fromDegrees(-74.028, 40.698, 600),
        orientation: {
            heading: Cesium.Math.toRadians(50.0),
            pitch: Cesium.Math.toRadians(-20.0),
            roll: 0.0
        },
        duration: 2.0
    });
}

// Moves camera to a top-down view
function flyToTopDown() {
    appState.viewer.camera.flyTo({
        destination: Cesium.Cartesian3.fromDegrees(-74.0030, 40.7060, 6000), 
        orientation: {
            heading: Cesium.Math.toRadians(33.5),
            pitch: Cesium.Math.toRadians(-90),
            roll: 0.0
        },
        duration: 2.0
    });
}

// Toggles the Custom 3D Model's visibility and hides overlapping buildings in the ion NYC tileset
function toggleModel() {
    const { tileset_customModel, tileset_nycBuildings, hiddenBuildings, ui } = appState;

    tileset_customModel.show = !tileset_customModel.show;

    if (tileset_customModel.show) {
        ui.toggleModelButton.classList.remove('is-off');
        ui.toggleModelButton.innerText = "Model: ON";

        if (!(hiddenBuildings && hiddenBuildings.length > 0)) return;

        // When our custom model is shown, we apply a style to the ion NYC tileset
        // to hide specific building IDs that overlap with the model.
        tileset_nycBuildings.style = new Cesium.Cesium3DTileStyle({
            color: 'color("grey", 1.0)',
            show: {
                conditions : hiddenBuildings
            },
        });
    }
    else {
        ui.toggleModelButton.classList.add('is-off');
        ui.toggleModelButton.innerText = "Model: OFF";
        
        // Show all buildings when custom model is hidden
        tileset_nycBuildings.style = new Cesium.Cesium3DTileStyle({
            color: 'color("grey", 1.0)',
            show: true
        });
    }
}

function toggleLineVisibility(lineKey, forceState = null) {
    const isHidden = appState.hiddenLines.has(lineKey);
    const shouldHide = (forceState !== null) ? !forceState : !isHidden;

    if (shouldHide) {
        appState.hiddenLines.add(lineKey);
    } else {
        appState.hiddenLines.delete(lineKey);
    }

    Object.values(appState.trainEntities).forEach(entity => {
        if (entity.route === lineKey) {
            entity.show = !shouldHide;
        }
    });

    if (appState.polylineCollection) {
        appState.polylineCollection._polylines.forEach(polyline => {
            if (!polyline.lineID) return;
            const routesOnTrack = polyline.lineID.split(/[- ]+/);
            polyline.show = routesOnTrack.some(r => !appState.hiddenLines.has(r));
        });
    }
}

function toggleGroupVisibility(lines, masterBtn) {
    const targetOn = masterBtn.classList.contains('is-off');

    lines.forEach(line => {
        const lineBtn = document.querySelector(`.line-toggle-btn[data-line="${line}"]`);
        
        if (lineBtn) {
            targetOn ? lineBtn.classList.remove('is-off') : lineBtn.classList.add('is-off');
        }

        toggleLineVisibility(line, targetOn);
    });

    targetOn ? masterBtn.classList.remove('is-off') : masterBtn.classList.add('is-off');
}

// --- Data Loading Functions ---

// Fetches subway line data and renders it in our scene
async function loadSubwayLines(state) {
    const { viewer } = state;

    try {
        const response = await fetch('https://data.ny.gov/api/geospatial/s692-irgq?method=export&format=GeoJSON');
        state.subwayLinesData = await response.json();
        
        // We pre-process the NYC subway tracks for easy lookup.
        state.subwayLinesData.features.forEach(feature => {
            const service = feature.properties.service;
            if (!service) return;

            const trackServiceArray = service.split(/[- ]+/);
            const primaryTrackLine = trackServiceArray[0].toUpperCase();
            const trackColorHex = getMTAColor(primaryTrackLine).toCssHexString();

            // We use Turf.js to flatten MultiLineStrings into simple LineStrings
            // This makes the map-matching logic significantly faster later on.
            const flat = turf.flatten(feature);

            trackServiceArray.forEach(line => {
                const lineKey = line.trim().toUpperCase();
                
                const lineColorHex = getMTAColor(lineKey).toCssHexString();

                // We only associate track geometry with a line if the colors match.
                if (lineColorHex === trackColorHex) {
                    if (!state.flattenedRouteMap[lineKey]) {
                        state.flattenedRouteMap[lineKey] = [];
                    }
                    state.flattenedRouteMap[lineKey].push(...flat.features);
                }
            });
        });

        // We draw the subway tracks.
        const subwaySource = await Cesium.GeoJsonDataSource.load(state.subwayLinesData, {
            stroke: Cesium.Color.TRANSPARENT,
            fill: Cesium.Color.TRANSPARENT
        });
       
        state.polylineCollection = viewer.scene.primitives.add(new Cesium.PolylineCollection());

        subwaySource.entities.values.forEach(entity => {
            const service = entity.properties.service.getValue();
            const polyline = state.polylineCollection.add({
                positions: entity.polyline.positions.getValue(Cesium.JulianDate.now()),
                width: 4,
                material: Cesium.Material.fromType('Color', { color: getMTAColor(service.split(/[- ]+/)[0]) })
            });
            // We attach a custom lineID property so we can toggle each subway line's visibility.
            polyline.lineID = service.trim().toUpperCase();
        });

        createSubwayLineToggles(state);

    } catch (error) { 
        console.error("Subway Initialization Error:", error);
    }
}

function createSubwayLineToggles(state) {
    const container = document.getElementById('line-toggle-container');
    container.innerHTML = '';

    const groups = [
        { name: '7th-Ave', lines: ['1', '2', '3'] },
        { name: 'Lexington', lines: ['4', '5', '6'] },
        { name: '8th-Ave', lines: ['A', 'C', 'E'] },
        { name: '6th-Ave', lines: ['B', 'D', 'F', 'M'] },
        { name: 'Broadway', lines: ['N', 'Q', 'R', 'W'] },
        { name: 'Flushing', lines: ['7'] },
        { name: 'Canarsie', lines: ['L'] },
        { name: 'Crosstown', lines: ['G'] },
        { name: 'Archer', lines: ['J', 'Z'] },
        { name: 'Staten-Island', lines: ['SIR'] }
    ];

    groups.forEach(group => {
        const row = document.createElement('div');
        row.className = 'group-row';

        const groupColor = getMTAColor(group.lines[0]).toCssColorString();

        // We make toggle buttons for each subway line group.
        const groupToggleButton = document.createElement('button');
        groupToggleButton.className = 'master-toggle-btn';
        groupToggleButton.innerHTML = '<span class="material-icons">visibility</span>';
        groupToggleButton.style.borderColor = groupColor;
        groupToggleButton.title = `Toggle all ${group.name} lines`;
        
        groupToggleButton.onclick = () => toggleGroupVisibility(group.lines, groupToggleButton);
        row.appendChild(groupToggleButton);

        // We make toggle buttons for each subway line.
        group.lines.forEach(line => {
            const toggleButton = document.createElement('button');
            toggleButton.innerText = line;
            toggleButton.className = 'line-toggle-btn';
            toggleButton.dataset.line = line;
            toggleButton.style.backgroundColor = getMTAColor(line).toCssColorString();

            toggleButton.onclick = () => {
                // We toggle the line's state.
                toggleButton.classList.toggle('is-off');
                toggleLineVisibility(line);

                // We find the group toggle button for this specific row.
                const row = toggleButton.closest('.group-row');
                const masterButton = row.querySelector('.master-toggle-btn');
                const allChildButtons = row.querySelectorAll('.line-toggle-btn');
                
                // The group button only stays ON if no children are OFF.
                // So, we check if all child subway lines are ON.
                const anyOff = Array.from(allChildButtons).some(b => b.classList.contains('is-off'));
                
                if (anyOff) {
                    masterButton.classList.add('is-off');
                } else {
                    masterButton.classList.remove('is-off');
                }
            };

            row.appendChild(toggleButton);
        });

        container.appendChild(row);
    });
}

// Loads and stylizes our 3D building tilesets
async function loadBuildings(state) {
    const { viewer } = state;

    try {
        // We load the custom model from Cesium Ion 
        state.tileset_customModel = await Cesium.Cesium3DTileset.fromIonAssetId(4428924);
        viewer.scene.primitives.add(state.tileset_customModel);

        // We apply a custom GLSL shader to the tiled buildings to enhance the night-mode aesthetic.
        state.tileset_customModel.customShader = new Cesium.CustomShader({
            fragmentShaderText: `
                void fragmentMain(FragmentInput fsInput, inout czm_modelMaterial material) {
                    material.diffuse = material.diffuse * 1.5;
                    material.emissive = material.diffuse * 0.5;
                }
            `
        });
    } catch (error) {
        console.error("Buildings Initialization Error:", error);
    }

    try {
        // We load the NYC buildings from Cesium Ion
        state.tileset_nycBuildings = await Cesium.Cesium3DTileset.fromIonAssetId(75343);
        viewer.scene.primitives.add(state.tileset_nycBuildings);

        // We fetch a list of building IDs that overlap with our custom model so we can hide them.
        const response = await fetch('./assets/hiddenBuildings.json');
        const hiddenBuildingIDs = await response.json();
        state.hideConditions = hiddenBuildingIDs.map(id => [`\${SOURCE_ID} === "${id}"`, "false"]);
        state.hideConditions.push([true, true]);

        state.tileset_nycBuildings.style = new Cesium.Cesium3DTileStyle({
            color: 'color("grey", 1.0)',
            show: {
            conditions : state.hideConditions
            },
        });
    } catch (error) {
        console.error("Initialization Error:", error);
    }
}

// --- Train Update Functions ---

// Polls our custom middleware API for live train data
async function updateTrains(state) {
    // We skip this update if data is not ready, or a previous request is still pending.
    if (!state.subwayLinesData || !state.flattenedRouteMap || state.isUpdating) return;
    
    state.isUpdating = true;

    try {
        const currentTime = state.viewer.clock.currentTime;
        const trainSpeed = 18; // We set our average subway speed (m/s)

        // We fetch our train data from our custom Vercel Proxy server.
        const response = await fetch('https://mta-proxy.vercel.app/api/subway');
        const allTrains = await response.json();

        // We use a chunk processor to spread the work across multiple frames.
        // This optimizes the processing of the 500+ trains and mitigates blocking the main UI thread.
        chunkProcessor(
            allTrains, 
            (train) => {
                processTrain(state, train, currentTime, trainSpeed);
            },
            () => {
                state.isUpdating = false;
            }
        );

    } catch (e) { 
        console.error("Update failed", e); 
        state.isUpdating = false;
    }
}

// Processes train data
function processTrain(state, train, currentTime, targetSpeed) {
    const trainId = train.id;
    const rawPos = Cesium.Cartesian3.fromDegrees(train.lon, train.lat, 5);
    let entity = state.trainEntities[trainId];
    state.lastSeenTimes[trainId] = Date.now();

    // We don't proceed if the data jumps positions or the train is stationary.
    if (handleUnwantedBehavior(state, train, rawPos, entity, currentTime)) return;

    // We find where the train should be on the tracks.
    const snapResult = findPositionAlongTrack(train, rawPos);
    if (!snapResult) return;
    const { newPos, closestLine, snappedNew } = snapResult;

    // We update the existing entity or create a new one.
    if (entity) {
        updateTrainAnimation(state, entity, newPos, closestLine, snappedNew, currentTime, targetSpeed);
    } else {
        createNewTrain(state, train, newPos, currentTime);
    }
}

// Guard train animation from unexpected behavior
function handleUnwantedBehavior(state, train, rawPos, entity, currentTime) {
    if (!entity || !state.lastKnownCoords[train.id]) return false;

    const dist = Cesium.Cartesian3.distance(state.lastKnownCoords[train.id], rawPos);

    // We guard against teleportation by checking if a train moves > 2km in 15 seconds 
    // If so, we assume it's a recycled train ID in the live data feed.
    // And, we force a position reset instead of interpolating.
    if (dist > 2000) {
        const jumpProp = new Cesium.SampledPositionProperty();
        setupProperty(jumpProp);
        jumpProp.addSample(currentTime, rawPos);
        entity.position = jumpProp;
        state.lastKnownCoords[train.id] = rawPos;
        return true;
    }

    // We pause the train's animation if the feed explicitly says the train's status is "stopped".
    if (train.status === 1) {
        entity.position.addSample(currentTime, rawPos);
        state.lastKnownCoords[train.id] = rawPos;
        return true;
    }

    return false;
}

// We align the noisy real-time position data to the subway tracks.
function findPositionAlongTrack(train, rawPos) {
    const flatSegments = appState.flattenedRouteMap[train.route];
    if (!flatSegments || flatSegments.length === 0) return null;

    const rawTrainPoint = turf.point([train.lon, train.lat]);
    let closestLine = flatSegments[0];
    let minDist = Infinity;

    // We find the train's closest track segment.
    for (const segment of flatSegments) {
        const dist = turf.pointToLineDistance(rawTrainPoint, segment);
        if (dist < minDist) {
            minDist = dist;
            closestLine = segment;
        }
    }

    // We calculate the position closest to the train's track.
    const snappedNew = turf.nearestPointOnLine(closestLine, rawTrainPoint);
    const newPos = Cesium.Cartesian3.fromDegrees(
        snappedNew.geometry.coordinates[0],
        snappedNew.geometry.coordinates[1],
        5
    );

    return { newPos, closestLine, snappedNew };
}

// We update the train's movement using temporal interpolation.
// Instead of jumping between points, we build an animation path to follow the curvature of the track geometry.
function updateTrainAnimation(state, entity, newPos, closestLine, snappedNew, currentTime, targetSpeed) {
    const trainId = entity.id;

    // We get the current interpolated position.
    const currentPos = entity.position.getValue(currentTime);
    if (!currentPos) return;

    // If the train hasn't moved significantly, we don't recalculate values.
    const distToNewTarget = Cesium.Cartesian3.distance(currentPos, newPos);
    if (distToNewTarget < 10) return;

    // We dynamically calculate the animation duration based on the travel distance and average speed.
    const calculatedDuration = Math.max(20, distToNewTarget / targetSpeed);
    const newProperty = new Cesium.SampledPositionProperty();
    setupProperty(newProperty);
    newProperty.addSample(currentTime, currentPos);

    // We use turf.lineSlice to generate points along the curved track geometry.
    const currentLLH = Cesium.Cartographic.fromCartesian(currentPos);
    const startPoint = turf.point([
        Cesium.Math.toDegrees(currentLLH.longitude), 
        Cesium.Math.toDegrees(currentLLH.latitude)
    ]);
    
    const pathSlice = turf.lineSlice(startPoint, snappedNew, closestLine);
    let coords = pathSlice.geometry.coordinates;

    if (coords.length > 1) {
        // We ensure the track slice goes in the train's direction of travel. 
        // If the dot product of the travel vector and track vector is negative, we reverse the segment.
        const travelVector = Cesium.Cartesian3.subtract(newPos, currentPos, new Cesium.Cartesian3());
        const p1 = Cesium.Cartesian3.fromDegrees(coords[0][0], coords[0][1], 5);
        const p2 = Cesium.Cartesian3.fromDegrees(coords[1][0], coords[1][1], 5);
        const trackVector = Cesium.Cartesian3.subtract(p2, p1, new Cesium.Cartesian3());

        if (Cesium.Cartesian3.dot(travelVector, trackVector) < 0) coords.reverse();

        // We add the sampled points along the curve for smooth animation.
        coords.forEach((coord, index) => {
            const timeOffset = (index / (coords.length - 1)) * calculatedDuration;
            const sampleTime = Cesium.JulianDate.addSeconds(currentTime, timeOffset, new Cesium.JulianDate());
            newProperty.addSample(sampleTime, Cesium.Cartesian3.fromDegrees(coord[0], coord[1], 5));
        });
    }

    // We assign the new property and update the last position.
    entity.position = newProperty;
    state.lastKnownCoords[trainId] = newPos; 
}

//Creates new train entities
function createNewTrain(state, train, newPos, currentTime) {
    const property = new Cesium.SampledPositionProperty();
    setupProperty(property);
    property.addSample(currentTime, newPos);

    // We create entities to visually represent the trains using the Entity API.
    // Note: For production apps using large amounts of entities, consider PrimitiveCollections for optimization.
    state.trainEntities[train.id] = state.viewer.entities.add({
        id: train.id,
        route: train.route,
        show: !state.hiddenLines.has(train.route),
        position: property,
        point: { 
            pixelSize: 10, 
            color: getMTAColor(train.route),
            outlineWidth: 2,

            // We disable depth testing so trains are always visible.
            disableDepthTestDistance: Number.POSITIVE_INFINITY 
        },
        label: { 
            text: train.route, 
            font: '14pt monospace', 
            pixelOffset: new Cesium.Cartesian2(0, -16),

            // We disable depth testing so labels are always visible.
            disableDepthTestDistance: Number.POSITIVE_INFINITY
        }
    })

    state.lastKnownCoords[train.id] = newPos;
}

// --- Initialization Functions ---

// Sets up the Cesium Viewer with Cesium World Terrain and custom stylized settings
async function initCesium() {
    // We fetch our API token from a secure backend.
    const configResponse = await fetch('https://mta-proxy.vercel.app/api/config');
    const configData = await configResponse.json();
    
    if (!configData.cesiumToken) throw new Error("Token not found in config response");
    Cesium.Ion.defaultAccessToken = configData.cesiumToken;

    try {
        const viewerOptions = {
            terrain: Cesium.Terrain.fromWorldTerrain(),

            // Prevent Bing Imagery Sessions
            baseLayer: false,
            baseLayerPicker: false,

            // Disable UI widgets
            infoBox: false,
            animation: false,
            timeline: false,
            geocoder: false,
            homeButton: false,
            sceneModePicker: false,

            // Performance
            shadows: false,
            requestRenderMode: false,
            targetFrameRate: 60,
        };

        const viewer = new Cesium.Viewer("cesiumContainer", viewerOptions);

        // NOTE: Using Sentinel-2 as an alternative to default Bing imagery due to Cesium Ion "Imagery Sessions" quota
        const sentinelImagery = await Cesium.IonImageryProvider.fromAssetId(3954);
        const sentinelLayer = viewer.imageryLayers.addImageryProvider(sentinelImagery);

        // We alter the imagery style to create a dark mode effect.
        sentinelLayer.brightness = 0.2;
        sentinelLayer.contrast = 0.8;
        sentinelLayer.saturation = 0.2;
        sentinelLayer.hue = 0.6;

        // We alter the environment style to create a dark mode effect.
        const { scene } = viewer;
        scene.sun.show = false;
        scene.moon.show = false;
        scene.skyAtmosphere.show = false;
        scene.skyBox.show = false;
        scene.backgroundColor = Cesium.Color.BLACK;
        scene.globe.showGroundAtmosphere = false;
        scene.globe.baseColor = Cesium.Color.BLACK;
        scene.fog.enabled = false;
        scene.fog.color = Cesium.Color.BLACK;

        // We set our initial camera view.
        viewer.camera.setView({
            destination: Cesium.Cartesian3.fromDegrees(-74.028, 40.698, 600),
            orientation: {
                heading: Cesium.Math.toRadians(50.0),
                pitch: Cesium.Math.toRadians(-20.0),
                roll: 0.0
            }
        });

        return viewer;

    } catch (error) {
        console.error("Cesium Initialization Error:", error);
    }
}

function initClock(state) {
    const { viewer } = state;
    
    const now = Cesium.JulianDate.now();

    // We start the simulation slightly in the past to buffer data.
    const startTime = Cesium.JulianDate.addSeconds(now, -120, new Cesium.JulianDate());
    
    viewer.clock.currentTime = startTime;
    viewer.clock.multiplier = 1.0; 
    viewer.clock.shouldAnimate = true;
    viewer.clock.clockStep = Cesium.ClockStep.SYSTEM_CLOCK_DEPENDENT;
}

// Assigns buttons to their respective handler functions
function setupUI(state) {
    state.ui.resetViewButton = document.getElementById('home-button');
    state.ui.topdownViewButton = document.getElementById('top-down-button');
    state.ui.toggleModelButton = document.getElementById('toggle-model-button');
    
    state.ui.resetViewButton.addEventListener('click', flyToHome);
    state.ui.topdownViewButton.addEventListener('click', flyToTopDown);
    state.ui.toggleModelButton.addEventListener('click', toggleModel);
}

// Starts up the application
async function initApp() {
    try {
        setupUI(appState);

        appState.viewer = await initCesium();

        initClock(appState);

        // We load in the static data.
        await loadBuildings(appState);  
        await loadSubwayLines(appState); 
        
        // We start the update loop for the train's real-time data feed.
        updateTrains(appState);

        setInterval(() => updateTrains(appState), 20000);

        appState.isLoaded = true;

    } catch (error) {
        console.error("Initialization Error:", error);
    }
}

// We start the application.
initApp();
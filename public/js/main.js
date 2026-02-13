/**
 * NYC Subway Live Tracker Demo
 * 
 * This application demonstrates how to build a high-fidelity real-time digital twin of 
 * New York City's subway lines using CesiumJS, Cesium World Terrain, a custom photogrammetry model, 
 * custom shaders, and real-time data feeds provided by Metropolitan Transportation Authority (MTA).
 */

let viewer;

// We initialize the token as empty. It will be fetched securely from our backend 
// to avoid exposing sensitive keys in the client-side source code.
Cesium.Ion.defaultAccessToken = '';

let tileset_customModel;
let tileset_nycBuildings;

// Stores building IDs so we can hide them
let hideConditions;

let subwayLinesData = null;
const trainEntities = {};

// Flattening the route map allows for optimized O(1) lookups during high-frequency updates
let flattenedRouteMap = {};

// Prevents visual "jumping" when IDs are recycled by the live data feed
const lastKnownCoords = {};

// Used to garbage collect "ghost trains" that vanish from the feed
const lastSeenTimes = {};

// Mutex lock to prevent overlapping network requests
let isUpdating = false;

// UI Elements
let resetViewButton;
let topdownViewButton;
let toggleModelButton;

// --- Button Handler Functions ---

// Resets the camera to the default view
function flyToHome() {
    viewer.camera.flyTo({
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
    viewer.camera.flyTo({
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
    tileset_customModel.show = !tileset_customModel.show;

    if (tileset_customModel.show) {
        toggleModelButton.classList.remove('is-off');
        toggleModelButton.innerText = "Model: ON";

        if (!(hideConditions && hideConditions.length > 0)) return;

        // When our custom model is shown, we apply a style to the ion NYC tileset
        // to hide specific building IDs that overlap with the model.
        tileset_nycBuildings.style = new Cesium.Cesium3DTileStyle({
            color: 'color("grey", 1.0)',
            show: {
                conditions : hideConditions
            },
        });
    }
    else {
        toggleModelButton.classList.add('is-off');
        toggleModelButton.innerText = "Model: OFF";
        
        // Show all buildings when custom model is hidden
        tileset_nycBuildings.style = new Cesium.Cesium3DTileStyle({
            color: 'color("grey", 1.0)',
            show: true
        });
    }
}

// --- Data Loading Functions ---

// Fetches subway line data and renders it in our scene
async function loadSubwayLines() {
    try {
        const response = await fetch('https://data.ny.gov/api/geospatial/s692-irgq?method=export&format=GeoJSON');
        subwayLinesData = await response.json();
        
        // We pre-process the NYC subway tracks for easy lookup
        subwayLinesData.features.forEach(feature => {
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

                // We only associate track geometry with a line if the colors match
                if (lineColorHex === trackColorHex) {
                    if (!flattenedRouteMap[lineKey]) {
                        flattenedRouteMap[lineKey] = [];
                    }
                    flattenedRouteMap[lineKey].push(...flat.features);
                }
            });
        });

        // We load data into a Data Source, then transfer to Primitives
        const subwaySource = await Cesium.GeoJsonDataSource.load(subwayLinesData, {
            stroke: Cesium.Color.TRANSPARENT,
            fill: Cesium.Color.TRANSPARENT
        });
       
        const polylineCollection = viewer.scene.primitives.add(new Cesium.PolylineCollection());

        subwaySource.entities.values.forEach(entity => {
            const service = entity.properties.service.getValue();
            polylineCollection.add({
                positions: entity.polyline.positions.getValue(Cesium.JulianDate.now()),
                width: 4,
                material: Cesium.Material.fromType('Color', { color: getMTAColor(service) })
            });
        });
    } catch (error) { console.error(error); }
}

// Loads and stylizes our 3D building tilesets
async function loadBuildings()
{
    try {
        // We load the custom model from Cesium Ion 
        tileset_customModel = await Cesium.Cesium3DTileset.fromIonAssetId(4428924);
        viewer.scene.primitives.add(tileset_customModel);

        // We apply a custom GLSL shader to the tiled buildings to enhance the night-mode aesthetic.
        tileset_customModel.customShader = new Cesium.CustomShader({
            fragmentShaderText: `
                void fragmentMain(FragmentInput fsInput, inout czm_modelMaterial material) {
                    material.diffuse = material.diffuse * 1.5;
                    material.emissive = material.diffuse * 0.5;
                }
            `
        });
    } catch (error) {
        console.error("Initialization Error:", error);
    }

    try {
        // We load the NYC buildings from Cesium Ion
        tileset_nycBuildings = await Cesium.Cesium3DTileset.fromIonAssetId(75343);
        viewer.scene.primitives.add(tileset_nycBuildings);

        // We fetch a list of building IDs that overlap with our custom model so we can hide them.
        const response = await fetch('./assets/hiddenBuildings.json');
        const hiddenBuildingIDs = await response.json();
        hideConditions = hiddenBuildingIDs.map(id => [`\${SOURCE_ID} === "${id}"`, "false"]);
        hideConditions.push([true, true]);

        tileset_nycBuildings.style = new Cesium.Cesium3DTileStyle({
            color: 'color("grey", 1.0)',
            show: {
            conditions : hideConditions
            },
        });
    } catch (error) {
        console.error("Initialization Error:", error);
    }
}

// --- Train Update Functions ---

// Polls our custom middleware API for live train data
async function updateTrains() {
    // We skip this update if data is not ready, or a previous request is still pending
    if (!subwayLinesData || !flattenedRouteMap || isUpdating) return;
    
    isUpdating = true;

    try {
        const currentTime = viewer.clock.currentTime;
        const trainSpeed = 18; // We set our average subway speed (m/s)

        // We fetch our train data from our custom Vercel Proxy server
        const response = await fetch('https://mta-proxy.vercel.app/api/subway');
        const allTrains = await response.json();

        // We use a chunk processor to spread the work across multiple frames.
        // This optimizes the processing of the 500+ trains and mitigates blocking the main UI thread.
        chunkProcessor(
            allTrains, 
            (train) => {
                processTrain(train, currentTime, trainSpeed);
            },
            () => {
                isUpdating = false;
            }
        );

    } catch (e) { 
        console.error("Update failed", e); 
        isUpdating = false;
    }
}

// Processes train data
function processTrain(train, currentTime, targetSpeed) {
    const trainId = train.id;
    const rawPos = Cesium.Cartesian3.fromDegrees(train.lon, train.lat, 5);
    let entity = trainEntities[trainId];
    lastSeenTimes[trainId] = Date.now();

    // We don't proceed if the data jumps positions or the train is stationary.
    if (handleUnwantedBehavior(train, rawPos, entity, currentTime)) return;

    // We find where the train should be on the tracks.
    const snapResult = findPositionAlongTrack(train, rawPos);
    if (!snapResult) return;
    const { newPos, closestLine, snappedNew } = snapResult;

    // We update the existing entity or create a new one.
    if (entity) {
        updateTrainAnimation(entity, newPos, closestLine, snappedNew, currentTime, targetSpeed);
    } else {
        createNewTrain(train, newPos, currentTime);
    }
}

// Guard train animation from unexpected behavior
function handleUnwantedBehavior(train, rawPos, entity, currentTime) {
    if (!entity || !lastKnownCoords[train.id]) return false;

    const dist = Cesium.Cartesian3.distance(lastKnownCoords[train.id], rawPos);

    // We guard against teleportation by checking if a train moves > 2km in 15 seconds 
    // If so, we assume it's a recycled train ID in the live data feed.
    // And, we force a position reset instead of interpolating.
    if (dist > 2000) {
        const jumpProp = new Cesium.SampledPositionProperty();
        setupProperty(jumpProp);
        jumpProp.addSample(currentTime, rawPos);
        entity.position = jumpProp;
        lastKnownCoords[train.id] = rawPos;
        return true;
    }

    // We pause the train's animation if the feed explicitly says the train's status is "stopped".
    if (train.status === 1) {
        entity.position.addSample(currentTime, rawPos);
        lastKnownCoords[train.id] = rawPos;
        return true;
    }

    return false;
}

// We align the noisy real-time position data to the subway tracks.
function findPositionAlongTrack(train, rawPos) {
    const flatSegments = flattenedRouteMap[train.route];
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
function updateTrainAnimation(entity, newPos, closestLine, snappedNew, currentTime, targetSpeed) {
    const trainId = entity.id;

    // We get the current interpolated position
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
    const currentCart = Cesium.Cartographic.fromCartesian(currentPos);
    const startPt = turf.point([
        Cesium.Math.toDegrees(currentCart.longitude), 
        Cesium.Math.toDegrees(currentCart.latitude)
    ]);
    
    const pathSlice = turf.lineSlice(startPt, snappedNew, closestLine);
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
    lastKnownCoords[trainId] = newPos; 
}

//Creates new train entities
function createNewTrain(train, newPos, currentTime) {
    const property = new Cesium.SampledPositionProperty();
    setupProperty(property);
    property.addSample(currentTime, newPos);

    // We create entities to visually represent the trains using the Entity API.
    // Note: For production apps using large amounts of entities, consider PrimitiveCollections for optimization.
    trainEntities[train.id] = viewer.entities.add({
        id: train.id,
        position: property,
        point: { 
            pixelSize: 10, 
            color: getMTAColor(train.route),
            outlineWidth: 2,

            // We disable depth testing so trains are always visible
            disableDepthTestDistance: Number.POSITIVE_INFINITY 
        },
        label: { 
            text: train.route, 
            font: '14pt monospace', 
            pixelOffset: new Cesium.Cartesian2(0, -16),

            // We disable depth testing so labels are always visible
            disableDepthTestDistance: Number.POSITIVE_INFINITY
        }
    })

    lastKnownCoords[train.id] = newPos;
}

// --- Initialization Functions ---

// Sets up the Cesium Viewer with Cesium World Terrain and custom stylized settings
async function initCesium() {
    // We fetch our API token from a secure backend
    const configResponse = await fetch('https://mta-proxy.vercel.app/api/config');
    const configData = await configResponse.json();
    
    if (configData.cesiumToken) {
        Cesium.Ion.defaultAccessToken = configData.cesiumToken;
    } else {
        throw new Error("Token not found in config response");
    }
    
    // We create our Cesium Viewer
    viewer = new Cesium.Viewer('cesiumContainer', {
        terrain: Cesium.Terrain.fromWorldTerrain(),      
        baseLayerPicker: false,
        infoBox: false,
        animation: false,
        timeline: false,
        geocoder: false,
        homeButton: false,
        sceneModePicker: false,
    });

    // We set our initial camera view
    viewer.camera.setView({
        destination: Cesium.Cartesian3.fromDegrees(-74.028, 40.698, 600),
        orientation: {
            heading: Cesium.Math.toRadians(50.0),
            pitch: Cesium.Math.toRadians(-20.0),
            roll: 0.0
        }
    });

    // We alter the scene's style to create a dark mode effect
    const layers = viewer.imageryLayers;
    const baseLayer = layers.get(0);
    baseLayer.brightness = 0.2;
    baseLayer.contrast = 0.8;
    baseLayer.saturation = 0.2;
    baseLayer.hue = 0.6;

    viewer.scene.sun.show = false;
    viewer.scene.moon.show = false;
    viewer.scene.skyAtmosphere.show = false;
    viewer.scene.skyBox.show = false;
    viewer.scene.backgroundColor = Cesium.Color.BLACK;
    viewer.scene.globe.showGroundAtmosphere = false;

    viewer.scene.fog.enabled = false;
    viewer.scene.fog.color = Cesium.Color.BLACK;
    viewer.scene.fog.minimumBrightness = 0.0;

    viewer.shadows = false

    viewer.scene.requestRenderMode = false;
    viewer.targetFrameRate = 60;

    return viewer;
}

function initClock() {
    const now = Cesium.JulianDate.now();

    // We start the simulation slightly in the past to buffer data.
    const startTime = Cesium.JulianDate.addSeconds(now, -120, new Cesium.JulianDate());
    
    viewer.clock.currentTime = startTime;
    viewer.clock.multiplier = 1.0; 
    viewer.clock.shouldAnimate = true;
    viewer.clock.clockStep = Cesium.ClockStep.SYSTEM_CLOCK_DEPENDENT;
}

// Assigns buttons to their respective handler functions
function setupUI() {
    resetViewButton = document.getElementById('home-button');
    topdownViewButton = document.getElementById('top-down-button');
    toggleModelButton = document.getElementById('toggle-model-button');
    
    resetViewButton.addEventListener('click', flyToHome);
    topdownViewButton.addEventListener('click', flyToTopDown);
    toggleModelButton.addEventListener('click', toggleModel);
}

// Starts up the application
async function initApp() {
    try {
        await initCesium();
        initClock();
        setupUI();

        // We load in the static data.
        await loadBuildings();  
        await loadSubwayLines(); 
        
        // We start the update loop for the train's real-time data feed.
        updateTrains();
        setInterval(updateTrains, 20000);

    } catch (error) {
        console.error("Initialization Error:", error);
    }
}

// We start the application.
initApp();
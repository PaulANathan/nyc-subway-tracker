/**
 * NYC Live Subway Tracker Demo Utilities
 * 
 * * A collection of helper functions to manage real-time transit data,
 * UI performance, and spatial properties within CesiumJS.
 */

// Processes large datasets in small batches to maintain FPS performance 
// by spreading the work across multiple frames
function chunkProcessor(items, processFn, onComplete, batchSize = 15) {
    let index = 0;
    function run() {
        const end = Math.min(index + batchSize, items.length);
        for (; index < end; index++) {
            processFn(items[index]);
        }

        // If there is more data, schedule the next batch for the next browser paint
        if (index < items.length) {
            requestAnimationFrame(run);
        } else if (onComplete) {
            onComplete();
        }
    }
    run();
}

// Returns the official MTA color for a given subway line
function getMTAColor(line) {
    if (!line) return Cesium.Color.WHITE;
    
    const lineStr = line.toString().toUpperCase().trim();

    // Official MTA Colors
    const colors = {
        '1': '#EE352E', '2': '#EE352E', '3': '#EE352E',
        '4': '#00933C', '5': '#00933C', '6': '#00933C',
        '7': '#B933AD',
        'A': '#0039A6', 'C': '#0039A6', 'E': '#0039A6', 'SIR': '#0039A6',
        'B': '#FF6319', 'D': '#FF6319', 'F': '#FF6319', 'M': '#FF6319',
        'G': '#6CBE45',
        'J': '#996633', 'Z': '#996633',
        'N': '#FCCC0A', 'Q': '#FCCC0A', 'R': '#FCCC0A', 'W': '#FCCC0A',
        'L': '#A7A9AC', 'S': '#808183', 'H': '#808183'
    };

    if (colors[lineStr]) return Cesium.Color.fromCssColorString(colors[lineStr]);

    //Fallback if initial lookup failed
    const hex = colors[lineStr.charAt(0)] || '#FFFFFF';
    return Cesium.Color.fromCssColorString(hex);
}

// Configures a SampledPositionProperty for optimal visualization
function setupProperty(prop) {
    // We set forwardExtrapolationType to HOLD to prevent trains 
    // from flying off into space if the live data feed lags.
    prop.forwardExtrapolationType = Cesium.ExtrapolationType.HOLD;

    // We use LinearApproximation for subways because they follow straight-line segments 
    // between track points.
    prop.setInterpolationOptions({
        interpolationDegree: 1, 
        interpolationAlgorithm: Cesium.LinearApproximation
    });
}
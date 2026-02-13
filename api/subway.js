import GtfsRealtimeBindings from 'gtfs-realtime-bindings';
import fetch from 'node-fetch';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const getStopLookup = () => {
    try {
        const filePath = path.join(__dirname, 'stops.txt'); 
        const csvData = fs.readFileSync(filePath, 'utf8');
        
        const lines = csvData.split('\n');
        const lookup = {};
        
        lines.forEach((line, index) => {
            if (index === 0 || !line.trim()) return;
            const [id, name, lat, lon] = line.split(',');
            if (id && lat && lon) {
                lookup[id] = { 
                    name, 
                    lat: parseFloat(lat), 
                    lon: parseFloat(lon) 
                };
            }
        });
        return lookup;
    } catch (err) {
        console.error("Error reading stops.txt:", err);
        return {};
    }
};

const STOP_LOOKUP = getStopLookup();

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');

    const FEED_URLS = [
        'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-ace',
        'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-g',
        'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-nqrw',
        'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs',
        'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-bdfm',
        'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-jz',
        'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-l',
        'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-si'
    ];

    try {
        let allTrains = [];

        // Fetch all feeds in parallel for speed
        const feedPromises = FEED_URLS.map(url => 
            fetch(url).then(r => r.arrayBuffer())
        );
        
        const buffers = await Promise.all(feedPromises);

        buffers.forEach(buffer => {
            const feed = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(new Uint8Array(buffer));
            
            feed.entity.forEach(e => {
                if (e.vehicle && e.vehicle.stopId) {
                    const stopId = e.vehicle.stopId;
                    const coords = STOP_LOOKUP[stopId];
                    
                    if (coords) {
                        allTrains.push({
                            id: e.id,
                            route: e.vehicle.trip.routeId,
                            lat: coords.lat,
                            lon: coords.lon,
                            stopName: coords.name,
                            status: e.vehicle.currentStatus
                        });
                    }
                }
            });
        });

        res.status(200).json(allTrains);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
}
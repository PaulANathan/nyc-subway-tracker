import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static('public'));

app.get('/api/subway', async (req, res) => {
    const { default: handler } = await import('./api/subway.js');
    await handler(req, res);
});

app.get('/api/config', async (req, res) => {
    const { default: handler } = await import('./api/config.js');
    await handler(req, res);
});

app.listen(PORT, () => {
    console.log(`app running at http://localhost:${PORT}`);
});
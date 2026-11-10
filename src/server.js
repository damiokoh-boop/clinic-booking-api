// Local development server: `npm start`.
import { createApp } from './app.js';

const port = Number(process.env.PORT || 3000);
createApp().listen(port, () => console.log(`Clinic booking API on http://localhost:${port}`));

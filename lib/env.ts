import { config } from "dotenv";

// Next loads .env.local by itself; the standalone scripts don't, and dotenv's
// own default only looks at .env.
config({ path: ".env.local" });

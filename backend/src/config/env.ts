import 'dotenv/config'; import { z } from 'zod';
const schema=z.object({DATABASE_URL:z.string().url(),PORT:z.coerce.number().default(5000),CLIENT_URL:z.string().url().default('http://localhost:5173'),GIPHY_API_KEY:z.string().optional(),TURN_SERVER_URL:z.string().optional(),TURN_USERNAME:z.string().optional(),TURN_PASSWORD:z.string().optional(),NODE_ENV:z.enum(['development','test','production']).default('development')});
export const env=schema.parse(process.env);

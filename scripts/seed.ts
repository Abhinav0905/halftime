// Replaces everything in the database with the sample club and season.
//
//   npm run seed                                  uses HALFTIME_DB from the environment or .env.local
//   HALFTIME_DB=./data/other.db npm run seed

import fs from "node:fs";
import path from "node:path";
import { dbPath } from "../lib/config";
import { seedDemo } from "../lib/seed";

// lib/config reads the environment lazily, so loading the file here is early enough.
const envFile = path.resolve(__dirname, "..", ".env.local");
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

seedDemo(true);
console.log(`Seeded the sample club and season into ${dbPath()}`);

#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
const body = process.argv[process.argv.indexOf("--body") + 1];
writeFileSync(process.env.PROFILE_FAKE_QUERY, readFileSync(body.slice(1)));
process.stdout.write(readFileSync(process.env.PROFILE_FAKE_RESPONSE));

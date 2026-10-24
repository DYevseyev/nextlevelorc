#!/usr/bin/env node
// nextlevel: run an AI build team from your own PC. `nextlevel help` lists the commands.
//
// Since safe updates each version runs from a folder of its own and the `nextlevel` command runs the launcher
// (src/launch.mjs). The tool's clone keeps a checkout too, which START.cmd names as its last way in: run there, this
// hands over to the launcher, so the version a project follows runs (never for _install, which the installer runs here).
import { main } from '../src/cli.mjs';
import { storeHandover } from '../src/lib/handover.mjs';

if (!(await storeHandover(process.argv.slice(2)))) process.exitCode = await main(process.argv.slice(2));

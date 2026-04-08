#!/usr/bin/env node
/**
 * Simulated lead generator for lokale IT-Ankaufsprojekte.
 * Läuft alleinstehend: `node automation/leads.js`
 */

const regions = ["Hamburg", "Berlin", "NRW", "Bayern", "Sachsen"];
const focus = ["ThinkPads", "MacBooks", "Workstations", "Server"];

function randomEntry(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

const leads = Array.from({ length: 10 }).map((_, i) => ({
  company: `IT-Service ${i + 1} GmbH`,
  city: randomEntry(regions),
  contact: `ankauf${i + 1}@example.com`,
  phone: `+49 40 555${400 + i}`,
  hardwareFocus: randomEntry(focus),
  quantityPotential: 10 + Math.floor(Math.random() * 50)
}));

console.log(JSON.stringify(leads, null, 2));

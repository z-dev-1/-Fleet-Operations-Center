'use strict';
/**
 * import_dealers.js — one-time importer for the four domicile dealer lists
 * (AVP40, ABE40, EWR45, PHL40) pasted from the dealer-locator tool.
 *
 * The vendor records below are the DEDUPED, pre-merged result of the four
 * lists: one entry per unique dealer, carrying every managed domicile it serves
 * and the distance (miles) from each of those sites. "⛔ Do Not Use" dealers
 * (Cambria-Edison, Cambria-Elizabeth, Bauer, Cummins East-Kearny) are omitted.
 *
 * mileageByDomicile holds distance from each of YOUR four domiciles when that
 * dealer appeared in that domicile's list. Pref tags that point at non-managed
 * sites (ABE2, ACY1, ILG1, ...) are kept verbatim in prefTags for reference and
 * do NOT make the dealer "serve" those sites. domiciles[] lists only the managed
 * sites (AVP40/ABE40/EWR45/PHL40) the dealer showed up under.
 *
 * USAGE (app MUST be closed — contacts.json is otherwise locked/raced):
 *   Dry-run (default, writes nothing, prints a plan):
 *     npx electron tools/import_dealers.js
 *   Apply:
 *     npx electron tools/import_dealers.js --apply
 *
 * Running under electron so app.getPath('userData') resolves to the SAME
 * contacts.json the app uses (%APPDATA%/fleet-ops-app). A plain `node` run
 * would resolve to ~/.fleet-ops and import into the wrong file.
 */

const path = require('path');

// ── Parsed + deduped vendor dataset ─────────────────────────────────────────
// make strings use the app's uppercase convention. mobile/cng come from the
// 🏷️ tags. affiliation from the 🔗 line. notes = the free-text description.
const VENDORS = [
  { name: 'Hunter Truck - Scranton', makes: ['PETERBILT', 'PACLEASE'], affiliation: 'PACCAR',
    street: '2900 Stafford Ave', city: 'Scranton', state: 'PA', zip: '18505',
    domiciles: ['AVP40'], mileageByDomicile: { AVP40: 4.3, ABE40: 53.1 },
    prefTags: ['AVP40 Pref #1'], notes: 'bodyshop' },

  { name: 'M&K Truck Centers - Scranton', makes: ['VOLVO', 'MACK', 'HINO'], mobile: true,
    street: '125 Monahan Ave', city: 'Dunmore', state: 'PA', zip: '18512',
    domiciles: ['AVP40'], mileageByDomicile: { AVP40: 9.7, ABE40: 56.3 },
    prefTags: ['AVP40 Pref #1', 'EWR4 Pref #1'] },

  { name: 'Ascendance Truck Centers - Allentown', makes: ['INTERNATIONAL', 'IDEALEASE', 'IC BUS'],
    mobile: true, cng: true, affiliation: 'Relay Garage/Reach',
    street: '2131 Hanover Avenue', city: 'Allentown', state: 'PA', zip: '18109',
    hours: 'M-F: 7a - 9p',
    domiciles: ['AVP40', 'ABE40', 'PHL40'], mileageByDomicile: { AVP40: 51.6, ABE40: 1.2, EWR45: 51.1, PHL40: 63.3 },
    prefTags: ['AVP40 Pref #1', 'ABE40 Pref #1', 'ABE2 Pref #1'],
    phone: '(484) 661-4193', notes: 'All makes, Mobile Service, Reach on-boarding in progress. Supporting ABE/AVP locations' },

  { name: 'PUSH & PULL', makes: ['FREIGHTLINER'],
    street: '4749 Grammes Rd', city: 'Allentown', state: 'PA', zip: '18104',
    domiciles: ['AVP40', 'ABE40', 'PHL40'], mileageByDomicile: { AVP40: 53.8, ABE40: 4.2, EWR45: 51.6, PHL40: 60.1 },
    prefTags: ['AVP40 Pref #1', 'ABE40 Pref #1'] },

  { name: 'Gabrielli Truck Sales & Service - Bloomsbury', makes: ['VOLVO', 'MACK', 'KENWORTH', 'HINO'], affiliation: 'PACCAR',
    street: '963 Route 173', city: 'Bloomsbury', state: 'NJ', zip: '08804', hours: 'Mon-Fri: 8 am - 6 pm',
    domiciles: ['AVP40', 'ABE40', 'PHL40'], mileageByDomicile: { AVP40: 57.9, ABE40: 19.4, PHL40: 68.6 },
    prefTags: ['AVP40 Pref #1', 'ABE40 Pref #1', 'LGA9 Pref #1'],
    phone: '908-479-4970 ext. 3230', email: 'mwolverton@gabriellitruck.com', contactPerson: 'Service Dept - Makayla Wolverton',
    notes: 'Volvo, Mack, Kenworth, Hino +. Towing, Body shop.' },

  { name: "Bergey's Truck Centers - Souderton", makes: ['VOLVO', 'MACK'], affiliation: 'Volvo Uptime',
    street: '446 Harleysville Pike', city: 'Souderton', state: 'PA', zip: '18964',
    domiciles: ['AVP40', 'ABE40', 'PHL40'], mileageByDomicile: { AVP40: 74.6, ABE40: 23.6, PHL40: 41.3 },
    prefTags: ['AVP40 Pref #1', 'ABE40 Pref #1'] },

  { name: 'Allegiance Truck Centers - Scranton', makes: ['INTERNATIONAL', 'AUTOCAR'], mobile: true, cng: true, affiliation: 'Relay Garage/Reach',
    street: '1006 Underwood Road', city: 'Olyphant', state: 'PA', zip: '18447', hours: 'M-F: 8a - 5p',
    domiciles: ['AVP40', 'ABE40'], mileageByDomicile: { AVP40: 11.3, ABE40: 57.4 },
    phone: '(570) 941-3600', notes: 'All makes, Mobile Service' },

  { name: 'Sherwood Freightliner & Western Star, Inc.', makes: ['FREIGHTLINER', 'WESTERN STAR'],
    street: '5578 SR 6', city: 'Tunkhannock', state: 'PA', zip: '18657',
    domiciles: ['AVP40'], mileageByDomicile: { AVP40: 17.9 },
    phone: '(570) 836-5027', notes: 'Full Service; Roadside Repair' },

  { name: 'Horwith Trucks Inc', makes: ['FREIGHTLINER'],
    street: '1449 Nor Bath Blvd', city: 'Northampton', state: 'PA', zip: '18067', hours: 'Mon – Fri: 7:00am – 11:30pm / 7AM–12PM',
    domiciles: ['AVP40', 'ABE40', 'PHL40'], mileageByDomicile: { AVP40: 46.0, ABE40: 5.0, EWR45: 56.3, PHL40: 68.4 },
    prefTags: ['ABE3 Pref #3'], phone: '(610) 261-2220', notes: 'freightliner' },

  { name: 'Doctor Diesel. PA', makes: [],
    street: '4822 Kernsville Rd', city: 'Orefield', state: 'PA', zip: '18069', hours: 'M-F, 8AM - 7PM',
    domiciles: ['AVP40', 'ABE40', 'PHL40'], mileageByDomicile: { AVP40: 48.8, ABE40: 7.7, EWR45: 58.4, PHL40: 64.5 },
    prefTags: ['ACY2 Pref #2'], phone: '(929) 398-8928', email: 'joey@docdiesel.com', contactPerson: 'John Tluczek',
    notes: 'Everything needed to repair daycabs to OEM spec' },

  { name: 'Transedge Truck Centers - Allentown', makes: ['VOLVO', 'MACK', 'HINO'],
    street: '1407 Bulldog Drive', city: 'Allentown', state: 'PA', zip: '18104', hours: 'Mon – Fri: 7:00am – 08:00pm Sat: 8AM–12PM',
    domiciles: ['AVP40', 'ABE40', 'PHL40'], mileageByDomicile: { AVP40: 51.1, ABE40: 6.4, EWR45: 55.9, PHL40: 62.3 },
    prefTags: ['ABE2 Pref #2'], phone: '(610) 395-6801', email: 'tom.epting@transedgetruck.com', contactPerson: 'Service Manager: Matt Gerecht',
    notes: 'Makes: Volvo/Mack/Hino' },

  { name: 'Hunter Truck - Allentown', makes: ['PETERBILT'], affiliation: 'PACCAR',
    street: '9981 Old U.S. 22', city: 'Breinigsville', state: 'PA', zip: '18031', hours: 'Mon – Fri 7 am – 12 am Sat 8 am – 4 pm',
    domiciles: ['AVP40', 'ABE40', 'PHL40'], mileageByDomicile: { AVP40: 52.1, ABE40: 13.9, EWR45: 61.0, PHL40: 61.7 },
    prefTags: ['HDC3 Pref #2', 'ABE40 Pref #1'], phone: '(610) 285-2244', email: 'nstettler@huntertrucksales.com', contactPerson: 'Nate Stettler',
    notes: 'dealer' },

  { name: 'Allegiance Truck Centers - Binghamton', makes: ['INTERNATIONAL', 'DE', 'AUTOCAR'], mobile: true, cng: true, affiliation: 'Relay Garage/Reach',
    street: '582 Conklin Road', city: 'Binghamton', state: 'NY', zip: '13903', hours: 'M-F: 8a - 5p',
    domiciles: ['AVP40'], mileageByDomicile: { AVP40: 53.5 },
    phone: '(607) 724-9125', notes: 'All makes, Mobile Service' },

  { name: 'W. Campbell Supply Company Of Sussex County, Llc', makes: ['FREIGHTLINER', 'WESTERN STAR'],
    street: '2 Route 94', city: 'Lafayette', state: 'NJ', zip: '07848',
    domiciles: ['AVP40', 'ABE40'], mileageByDomicile: { AVP40: 57.3, ABE40: 51.0 },
    phone: '(973) 756-1600', notes: 'Parts & Services; Uptime Pro' },

  { name: 'Kenworth of PA - Shartlesville', makes: ['KENWORTH'], affiliation: 'PACCAR',
    street: '16 Motel Dr', city: 'Shartlesville', state: 'PA', zip: '19554',
    domiciles: ['AVP40', 'ABE40', 'PHL40'], mileageByDomicile: { AVP40: 59.5, ABE40: 35.9, PHL40: 66.1 },
    prefTags: ['AVP8 Pref #2'], notes: 'Eaton' },

  { name: 'Coopersburg Kenworth', makes: ['KENWORTH'], mobile: true, affiliation: 'PACCAR',
    street: '1930 PA-309', city: 'Coopersburg', state: 'PA', zip: '18036', hours: 'M-F 7am-11pm Saturday 7am-12pm',
    domiciles: ['AVP40', 'ABE40', 'PHL40'], mileageByDomicile: { AVP40: 60.3, ABE40: 9.3, EWR45: 44.2, PHL40: 54.9 },
    prefTags: ['ABE2 Pref #1'], phone: '(609) 802-6535; (610) 282-4500', email: 'ttrembler@coopskw.com', contactPerson: 'Mobile Tech Manager Matthew Agati; Tracy Trembler, Service Manager',
    notes: 'Mobile Maint. Kenworth/Peterbilt, Cummins, PACCAR certified. Eaton trans and body shop' },

  { name: 'Robert H. Hoover & Sons, Inc.', makes: ['FREIGHTLINER', 'WESTERN STAR'],
    street: '149 Gold Mine Road', city: 'Flanders', state: 'NJ', zip: '07836',
    domiciles: ['AVP40', 'ABE40'], mileageByDomicile: { AVP40: 62.6, ABE40: 42.8, EWR45: 52.4 },
    notes: 'Full Service; Uptime Pro', phone: '(973) 347-4210' },

  { name: 'Berman Truck Group', makes: ['FREIGHTLINER', 'WESTERN STAR'], affiliation: 'DTNA (Service Tracker)',
    street: '175 Legion Drive', city: 'Bethel', state: 'PA', zip: '19507',
    domiciles: ['AVP40', 'ABE40', 'PHL40'], mileageByDomicile: { AVP40: 65.4, ABE40: 45.4, PHL40: 69.4 },
    phone: '(717) 933-5656', notes: 'Parts & Services; Uptime Pro; Roadside Repair' },

  { name: 'Ascendance Truck Centers - Reading', makes: ['INTERNATIONAL', 'IC BUS'], mobile: true, cng: true, affiliation: 'Relay Garage/Reach',
    street: '1846 N. 5th Street', city: 'Reading', state: 'PA', zip: '19601', hours: 'M-F: 7a - 5p',
    domiciles: ['AVP40', 'ABE40', 'PHL40'], mileageByDomicile: { AVP40: 67.5, ABE40: 31.2, PHL40: 52.1 },
    phone: '(610) 370-8165', notes: 'All makes, Mobile Service' },

  { name: 'Cummins East - Williamsport', makes: ['CUMMINS'],
    street: '2683 Lycoming Creek Road', city: 'Williamsport', state: 'PA', zip: '17701',
    domiciles: ['AVP40'], mileageByDomicile: { AVP40: 68.1 },
    phone: '570-505-3020' },

  { name: 'Ascendance Truck Centers - Williamsport', makes: ['INTERNATIONAL', 'IC BUS'], mobile: true, cng: true, affiliation: 'Relay Garage/Reach',
    street: '2751 McCoy Street', city: 'Williamsport', state: 'PA', zip: '17707', hours: 'M-F: 7a - 5p',
    domiciles: ['AVP40'], mileageByDomicile: { AVP40: 68.2 },
    phone: '(570) 601-6765', notes: 'All makes, Mobile Service' },

  { name: 'Gabrielli Truck Sales & Service - Rockaway', makes: ['VOLVO', 'MACK', 'KENWORTH', 'HINO'], affiliation: 'PACCAR',
    street: '80 Green Pond Road', city: 'Rockaway', state: 'NJ', zip: '07866',
    domiciles: ['AVP40', 'ABE40', 'EWR45'], mileageByDomicile: { AVP40: 70.9, ABE40: 53.7, EWR45: 56.1 },
    notes: 'Volvo, Mack, Kenworth, Hino +' },

  // ── ABE40-first appearances ────────────────────────────────────────────────
  { name: 'Allegiance Truck Centers - Flemington', makes: ['INTERNATIONAL'], mobile: true, cng: true, affiliation: 'Relay Garage/Reach',
    street: '356 NJ-31', city: 'Flemington', state: 'NJ', zip: '08822', hours: 'M-F: 7a - 5p',
    domiciles: ['ABE40', 'EWR45', 'PHL40'], mileageByDomicile: { ABE40: 32.2, EWR45: 27.2, PHL40: 63.1 },
    phone: '(908) 284-6060', notes: 'All makes, Mobile Service' },

  { name: 'Allegiance Truck Centers - Bucks County', makes: ['INTERNATIONAL'], mobile: true, cng: true, affiliation: 'Relay Garage/Reach',
    street: '134 Old Oxford Valley Road', city: 'Langhorne', state: 'PA', zip: '19047', hours: 'M-F: 7a - 5p',
    domiciles: ['ABE40', 'EWR45', 'PHL40'], mileageByDomicile: { ABE40: 42.5, EWR45: 9.8, PHL40: 45.5 },
    phone: '(267) 397-4000', notes: 'All makes, Mobile Service' },

  { name: 'Ascendance Truck Centers - Philadelphia', makes: ['INTERNATIONAL', 'IDEALEASE'], mobile: true, cng: true, affiliation: 'Relay Garage/Reach',
    street: '2811 Charter Road', city: 'Philadelphia', state: 'PA', zip: '19154', hours: 'M-F: 7a - 6p',
    domiciles: ['ABE40', 'EWR45', 'PHL40'], mileageByDomicile: { ABE40: 43.3, EWR45: 15.8, PHL40: 35.5 },
    prefTags: ['PHL40 Pref #2'], phone: '(215) 856-7601', notes: 'All makes, Mobile Service, Supporting PHL overflow' },

  { name: 'YTS - Yard Truck Specialists', makes: ['OTTAWA'],
    street: '1510 Ford Road', city: 'Bensalem', state: 'PA', zip: '19020', hours: 'M-F 8am-4pm',
    domiciles: ['ABE40', 'EWR45', 'PHL40'], mileageByDomicile: { ABE40: 45.1, EWR45: 11.7, PHL40: 38.8 },
    prefTags: ['CDW5 Specialist', 'EWR5 Specialist'], phone: '(215) 244-1773', email: 'info@yardtruck.com', contactPerson: 'Chet',
    notes: 'Ottawa, Autocar, TICO, Cummins and Allison. (YTS / "Yard Truck" are the same shop.)' },

  { name: 'Cummins East - Bristol', makes: ['CUMMINS'],
    street: '2727 Ford Road', city: 'Bristol', state: 'PA', zip: '19007',
    domiciles: ['ABE40', 'EWR45', 'PHL40'], mileageByDomicile: { ABE40: 45.6, EWR45: 9.7, PHL40: 40.8 },
    phone: '215-785-6005' },

  { name: 'Freightliner Of Philadelphia', makes: ['FREIGHTLINER', 'WESTERN STAR'],
    street: '11 Runway Road', city: 'Levittown', state: 'PA', zip: '19057',
    domiciles: ['ABE40', 'EWR45', 'PHL40'], mileageByDomicile: { ABE40: 46.8, EWR45: 7.4, PHL40: 42.8 },
    phone: '(215) 945-0350', notes: 'Full Service' },

  { name: 'Liberty Kenworth of Bristol', makes: ['KENWORTH'], mobile: true, affiliation: 'PACCAR',
    street: '200 US-13', city: 'Bristol', state: 'PA', zip: '19007', hours: 'M-F, 8am - 4pm',
    domiciles: ['ABE40', 'EWR45', 'PHL40'], mileageByDomicile: { ABE40: 47.4, EWR45: 8.5, PHL40: 40.9 },
    prefTags: ['ILG1 Pref #1'], phone: '(267)-540-8797 (609) 491-0895 (609) 586-333 (856) 662-7601',
    notes: 'Everything needed to repair daycabs to OEM spec. Body shop at: Coopersburg Kenworth location only.' },

  { name: "Bergey's Truck Centers - Pennsauken", makes: ['VOLVO', 'MACK', 'AUTOCAR', 'WABASH'], mobile: true, cng: true, affiliation: 'Volvo Uptime',
    street: '7255 N Crescent Blvd', city: 'Pennsauken', state: 'NJ', zip: '08110', hours: 'M-F: 7- 7 | Sat: 8-12p | Roadside: 24hr',
    domiciles: ['ABE40', 'EWR45', 'PHL40'], mileageByDomicile: { ABE40: 50.1, EWR45: 20.8, PHL40: 27.8 },
    prefTags: ['ACY1 Pref #3', 'PHL40 Pref #1'], phone: '(856) 662-7601', contactPerson: 'Jeff Corey, Service mgr',
    notes: 'Volvo, Mack, Autocar, Cummins and Wabash. Cert: Uptime, CNG Cummins, Eaton. Tire Hours: M-F 7:00 AM-4:00 PM' },

  { name: "Bergey's Truck Centers - Trenton", makes: ['VOLVO', 'MACK', 'AUTOCAR', 'HINO', 'WABASH'], cng: true, affiliation: 'Volvo Uptime',
    street: '5 Crossroads Dr', city: 'Trenton', state: 'NJ', zip: '08691', hours: 'M-F, 7am - 5pm',
    domiciles: ['ABE40', 'EWR45', 'PHL40'], mileageByDomicile: { ABE40: 50.6, EWR45: 6.1, PHL40: 53.8 },
    prefTags: ['ILG1 Pref #2'], email: 'pennsaukentire@bergeys.com', contactPerson: "Bergey's Trenton",
    notes: 'Volvo, Mack, Autocar, Hino, Wabash, Cummins. EV and CNG certified.' },

  { name: 'Gabrielli Truck Sales & Service - Dayton', makes: ['VOLVO', 'MACK', 'KENWORTH', 'HINO'], affiliation: 'PACCAR',
    street: '2306 US-130', city: 'Dayton', state: 'NJ', zip: '08810', hours: 'M-F, 8AM - 7PM',
    domiciles: ['ABE40', 'EWR45', 'PHL40'], mileageByDomicile: { ABE40: 52.6, EWR45: 20.4, PHL40: 67.8 },
    prefTags: ['ACY8 Pref #1', 'EWR45 Pref #2'], phone: '(732) 997-4613',
    email: 'svcday@gabriellitruck.com, dlglesias@gabriellitruck.com, kpontecorvo@gabriellitruck.com, nrivera@gabriellitruck.com',
    contactPerson: 'Danny, Noel, Karoll', notes: 'Volvo, Mack, Kenworth, Hino +' },

  { name: "Treat's Garage", makes: [],
    street: '1310 US-130', city: 'Windsor', state: 'NJ', zip: '08561', hours: 'M-F, 7am - 5pm',
    domiciles: ['ABE40', 'EWR45', 'PHL40'], mileageByDomicile: { ABE40: 53.1, EWR45: 11.1, PHL40: 59.4 },
    prefTags: ['ABE8 Pref #3'], phone: '(609) 448-1123', email: 'treats.mackeys@gmail.com', contactPerson: 'Shanon',
    notes: 'Power Units (Critical) | Towing (All Units)' },

  { name: 'W. Campbell Supply Company Of Raritan Center, Llc', makes: ['FREIGHTLINER', 'WESTERN STAR'],
    street: '1080 King Georges Post Road', city: 'Edison', state: 'NJ', zip: '08837',
    domiciles: ['ABE40', 'EWR45'], mileageByDomicile: { ABE40: 55.6, EWR45: 30.7 },
    phone: '(732) 623-2500', notes: 'Parts & Services; Uptime Pro' },

  { name: 'Penske - East Windsor', makes: [],
    street: '2682 US-130', city: 'Cranbury', state: 'NJ', zip: '08512', hours: 'M-F, 8am - 5pm',
    domiciles: ['ABE40', 'EWR45', 'PHL40'], mileageByDomicile: { ABE40: 53.7, EWR45: 16.9, PHL40: 64.8 },
    prefTags: ['ABE8 Pref #2'], phone: '(732) 438-0120', email: 'Daniel.Garrido@penske.com', contactPerson: 'Daniel Garillo',
    notes: 'Penske Units' },

  { name: 'Campbell Supply Company', makes: ['FREIGHTLINER'], mobile: true, cng: true,
    street: '1015 Cranbury - South River Rd', city: 'Monroe Township', state: 'NJ', zip: '08831',
    domiciles: ['ABE40', 'EWR45', 'PHL40'], mileageByDomicile: { ABE40: 54.6, EWR45: 20.9, PHL40: 68.7 },
    prefTags: ['EWR40 Pref #1'], phone: '(732) 287-1500',
    notes: 'Tractors+Hostlers Ottawa (engine/transmission issues only). CNG, Mobile Maintenance, and Allison' },

  { name: 'Freightliner Of Lebanon', makes: ['FREIGHTLINER', 'WESTERN STAR'],
    street: '32 Old Forge Road', city: 'Jonestown', state: 'PA', zip: '17038',
    domiciles: ['ABE40'], mileageByDomicile: { ABE40: 56.3 },
    phone: '(717) 820-2940', notes: 'Parts & Services; Roadside Repair' },

  { name: 'Allegiance Truck Centers - Union County', makes: ['ISUZU'], mobile: true, cng: true, affiliation: 'Relay Garage/Reach',
    street: '1463 US-22', city: 'Mountainside', state: 'NJ', zip: '07092', hours: 'M-F: 8a - 5p',
    domiciles: ['ABE40', 'EWR45'], mileageByDomicile: { ABE40: 56.9, EWR45: 42.0 },
    phone: '(908) 232-4600', notes: 'All makes, Mobile Service' },

  { name: 'Ascendance Truck Centers - Swedesboro', makes: ['INTERNATIONAL'], mobile: true, cng: true, affiliation: 'Relay Garage/Reach',
    street: '2320 High Hill Road', city: 'Swedesboro', state: 'NJ', zip: '08085', hours: 'M-F: 7a - 6p',
    domiciles: ['ABE40', 'EWR45', 'PHL40'], mileageByDomicile: { ABE40: 58.3, EWR45: 42.1, PHL40: 6.6 },
    prefTags: ['ACY1 Pref #1', 'PHL40 Pref #1'], phone: '(856) 241-8890',
    notes: 'All makes, Mobile Service, Reach on-boarding in progress. Supporting PHL/ACY/LDJ locations' },

  { name: 'Freightliner: Campbell Supply Co. Raritan NJ', makes: ['FREIGHTLINER'],
    street: '1080 King Georges Post Rd', city: 'Keasbey', state: 'NJ', zip: '08832', hours: 'M-F, 8A-6P',
    domiciles: ['ABE40', 'EWR45'], mileageByDomicile: { ABE40: 59.1, EWR45: 34.2 },
    prefTags: ['LGA9 Pref #3'], phone: '(732) 623-2500', email: 'shuff@campbellsupply.com', contactPerson: 'Service Dept - Sharon Huff/Alex Wilk',
    notes: 'Everything needed to repair Freightliner daycabs to OEM spec' },

  { name: 'Liberty Kenworth of South Jersey', makes: ['KENWORTH'],
    street: '2160 US-322', city: 'Swedesboro', state: 'NJ', zip: '08085', hours: 'M-F: 7- 11p / Sat: 8-12p',
    domiciles: ['ABE40', 'EWR45', 'PHL40'], mileageByDomicile: { ABE40: 59.6, EWR45: 40.6, PHL40: 7.9 },
    prefTags: ['ABE2 Pref #3'] },

  { name: 'Freightliner of Bridgeport (AKA: Transteck, Inc.)', makes: ['FREIGHTLINER'],
    street: '400 Heron Dr', city: 'Swedesboro', state: 'NJ', zip: '08085',
    domiciles: ['ABE40', 'EWR45', 'PHL40'], mileageByDomicile: { ABE40: 60.0, EWR45: 43.0, PHL40: 5.5 },
    prefTags: ['PHL40 Pref #1'], notes: 'Full Service - Does not use UTP (No Service Tracker usage!)' },

  // ── EWR45-first appearances ─────────────────────────────────────────────────
  { name: 'Hunter Truck - Clarksburg', makes: ['PETERBILT', 'PACLEASE'], mobile: true, affiliation: 'PACCAR',
    street: '524 Monmouth Rd', city: 'Clarksburg', state: 'NJ', zip: '08510', hours: 'Mon-Fri 6:00-23:00 || Sat 8:00-12:00',
    domiciles: ['EWR45', 'PHL40'], mileageByDomicile: { EWR45: 14.9, PHL40: 62.1 },
    prefTags: ['EWR45 Pref #1', 'EWR40 Pref #1'], phone: '(609) 259-5950', notes: 'All makes.' },

  { name: 'Avenel Truck & Equipment (AT&E)', makes: ['KALMAR OTTAWA'],
    street: '200 Essex Ave E', city: 'Avenel', state: 'NJ', zip: '07001', hours: 'M-F 8 am – 5 pm',
    domiciles: ['EWR45'], mileageByDomicile: { EWR45: 38.9 },
    prefTags: ['EWR45 Pref #1'], phone: '(732) 636-7400', email: 'ateservice@aveneltruck.com', contactPerson: 'Freddy',
    notes: 'Ottawa. Cummins, Allison' },

  { name: 'Allegiance Truck Centers - Linden', makes: ['INTERNATIONAL', 'WABASH', 'DE', 'TROUT RIVER', 'AUTOCAR'], mobile: true, cng: true, affiliation: 'Relay Garage/Reach',
    street: '1410 East Linden Avenue', city: 'Linden', state: 'NJ', zip: '07036', hours: 'M-F: 7:30a - 6p',
    domiciles: ['EWR45'], mileageByDomicile: { EWR45: 43.6 },
    prefTags: ['EWR45 Pref #1'], phone: '(908) 862-8181', notes: 'All makes, Mobile Service, Reach on-boarding in progress. Supporting EWR/LGA/JFK/CDW/TEB locations' },

  { name: 'Hudson County Motors - Secaucus', makes: ['VOLVO', 'AUTOCAR', 'BYD'], affiliation: 'Volvo Uptime',
    street: '290 Secaucus Rd', city: 'Secaucus', state: 'NJ', zip: '07094', hours: 'M-F, 8A-6P',
    domiciles: ['EWR45'], mileageByDomicile: { EWR45: 56.5 },
    prefTags: ['EWR45 Pref #1'], phone: '(201) 866-5570', email: 'jrypkema@hudsoncountymotors.com', contactPerson: 'Jason R.',
    notes: 'Volvo, Autocar, BYD. Volvo Uptime.' },

  { name: 'Meadowlands Freightliner', makes: ['FREIGHTLINER'],
    street: '707 Valley Brook Ave', city: 'Lyndhurst', state: 'NJ', zip: '07071',
    domiciles: ['EWR45'], mileageByDomicile: { EWR45: 56.5 },
    prefTags: ['EWR45 Pref #3'], notes: 'Full Service; Uptime Pro; Body Shop; Roadside Repair' },

  { name: 'Elizabeth Truck Center (CCTW) of Morganville', makes: ['INDEPENDENT'], affiliation: 'PACCAR',
    street: '', city: '', state: 'NJ', zip: '',
    domiciles: ['EWR45', 'PHL40'], mileageByDomicile: { EWR45: 16.4, PHL40: 60.7 },
    notes: 'Heavy Truck Collision repair: 6 Techs. Boxtruck repair. Free delivery <150 miles. Towing avail. Partnering with PACCAR for invoicing options.' },

  { name: 'Elizabeth Truck Center (CCTW) of Matawan', makes: ['INDEPENDENT'], affiliation: 'PACCAR',
    street: '396 NJ-34', city: 'Matawan', state: 'NJ', zip: '07747',
    domiciles: ['EWR45'], mileageByDomicile: { EWR45: 31.0 },
    notes: 'Heavy Truck Collision repair: 10 Techs. Box & Body. Boxtruck repair. Free delivery <150 miles. Towing avail. Partnering with PACCAR for invoicing options.' },

  { name: 'Car Craft Truck Works (CCTW)', makes: ['INDEPENDENT'], affiliation: 'Relay Garage/Reach',
    street: '528 Industrial Loop W', city: 'Staten Island', state: 'NY', zip: '10309', hours: 'Mon-Fri: 7am-6pm | Sat: 7am-1pm',
    domiciles: ['EWR45'], mileageByDomicile: { EWR45: 38.6 },
    phone: '718-948-6422', notes: 'Heavy Truck Collision repair: 28 Techs. Chassis, Frame, Box & Body. Boxtruck & Trailer repair. Free delivery <150 miles. Towing avail. Now integrated into RG via Reach.' },

  { name: 'Kenworth - Pete Store', makes: ['KENWORTH'],
    street: '', city: '', state: '', zip: '',
    domiciles: ['EWR45', 'PHL40'], mileageByDomicile: { EWR45: 40.2, PHL40: 8.4 },
    prefTags: ['CAE1 Pref #2'] },

  { name: 'Allegiance Truck Centers - Newark', makes: ['INTERNATIONAL', 'WABASH', 'DE', 'AUTOCAR'], mobile: true, cng: true, affiliation: 'Relay Garage/Reach',
    street: '46-100 Paris Street', city: 'Newark', state: 'NJ', zip: '07105', hours: 'M-F: 8a - 5p',
    domiciles: ['EWR45'], mileageByDomicile: { EWR45: 50.9 },
    phone: '(201) 372-0600', notes: 'All makes, Mobile Service' },

  { name: 'Allegiance Truck Centers - Brooklyn - 2nd Avenue', makes: ['INTERNATIONAL', 'WABASH', 'DE', 'AUTOCAR'], mobile: true, cng: true, affiliation: 'Relay Garage/Reach',
    street: '5001 2nd Avenue', city: 'Brooklyn', state: 'NY', zip: '11232', hours: 'M-F: 8a - 6p',
    domiciles: ['EWR45'], mileageByDomicile: { EWR45: 51.4 },
    phone: '718-649-8400', notes: 'All makes, Mobile Service' },

  { name: 'Allegiance Truck Centers - Brooklyn - Avenue D', makes: ['INTERNATIONAL', 'WABASH', 'DE', 'AUTOCAR'], mobile: true, cng: true, affiliation: 'Relay Garage/Reach',
    street: '9505 Avenue D', city: 'Brooklyn', state: 'NY', zip: '11236', hours: 'M-F: 8a - 6p',
    domiciles: ['EWR45'], mileageByDomicile: { EWR45: 55.5 },
    phone: '718-649-8400', notes: 'All makes, Mobile Service' },

  { name: 'W. Campbell Supply Company Of Port Newark, Llc', makes: ['FREIGHTLINER', 'WESTERN STAR'],
    street: '299 Roanoke Avenue', city: 'Newark', state: 'NJ', zip: '07105',
    domiciles: ['EWR45'], mileageByDomicile: { EWR45: 51.8 },
    phone: '(973) 589-2877', notes: 'Full Service; Uptime Pro' },

  { name: 'Hunter Truck - Pennsville', makes: ['PETERBILT'], affiliation: 'PACCAR',
    street: '454 N Broadway', city: 'Pennsville', state: 'NJ', zip: '08070',
    domiciles: ['EWR45', 'PHL40'], mileageByDomicile: { EWR45: 51.8, PHL40: 3.4 },
    prefTags: ['ACY1 Pref #2', 'PHL40 Pref #2'] },

  { name: 'Bayshore Truck Center', makes: ['FREIGHTLINER', 'WESTERN STAR'],
    street: '4003 N. Dupont Hwy', city: 'New Castle', state: 'DE', zip: '19720',
    domiciles: ['EWR45', 'PHL40'], mileageByDomicile: { EWR45: 53.6, PHL40: 6.4 },
    phone: '(302) 656-3160', notes: 'Parts & Services; Uptime Pro' },

  { name: "Bergey's Truck Centers - New Castle", makes: ['VOLVO', 'MACK', 'CUMMINS', 'AUTOCAR'], mobile: true, cng: true,
    street: '29 Commons Blvd', city: 'New Castle', state: 'DE', zip: '19720', hours: 'Mon-Fri: 7:00 AM - 8:00 PM, Sat: 7:00 AM - 12:00 PM',
    domiciles: ['EWR45', 'PHL40'], mileageByDomicile: { EWR45: 55.7, PHL40: 8.2 },
    prefTags: ['ABE2 Pref #1', 'PHL40 Pref #1'], phone: '(302) 324-8340',
    notes: 'Official: Volvo/Mack/Cummins/Autocar: Mobile Service; CNG Certified; EV: Eaton/Meritor transmission certified- Dealer can do everything' },

  { name: 'W. Campbell Supply Company Of Atlantic County, Llc', makes: ['FREIGHTLINER', 'WESTERN STAR'],
    street: '489 Stow Creek Road', city: 'Bridgeton', state: 'NJ', zip: '08302',
    domiciles: ['EWR45', 'PHL40'], mileageByDomicile: { EWR45: 55.7, PHL40: 22.3 },
    phone: '(856) 455-4242', notes: 'Full Service; Uptime Pro' },

  { name: 'New York Freightliner', makes: ['FREIGHTLINER', 'WESTERN STAR'],
    street: '12901 Atlantic Ave', city: 'Richmond Hill', state: 'NY', zip: '11418',
    domiciles: ['EWR45'], mileageByDomicile: { EWR45: 45.8 },
    phone: '(718) 846-8150', notes: 'Full Service; Uptime Pro' },

  { name: 'Elizabeth Truck Center (CCTW)', makes: ['INDEPENDENT'], affiliation: 'PACCAR',
    street: '878 North Ave E', city: 'Elizabeth', state: 'NJ', zip: '07201', hours: 'Mon-Fri: 8am-5pm',
    domiciles: ['EWR45'], mileageByDomicile: { EWR45: 46.8 },
    notes: 'Heavy Truck Collision repair: 32 Techs. Chassis, Frame, Box & Body. Boxtruck repair. Free delivery <150 miles. Towing avail. Partnering with PACCAR for invoicing options.' },

  { name: 'Gabrielli Truck Sales - Fairview', makes: ['VOLVO', 'ISUZU'], cng: true,
    street: '109 Broad Ave', city: 'Fairview', state: 'NJ', zip: '07022',
    domiciles: ['EWR45'], mileageByDomicile: { EWR45: 60.5 },
    notes: 'Cert: CNG, Cummins (warranty)' },

  { name: 'Gabrielli Truck Sales & Service - Ridgefield Park', makes: ['VOLVO', 'MACK', 'KENWORTH', 'HINO', 'FORD', 'ISUZU'], cng: true, affiliation: 'PACCAR',
    street: '239 Bergen Turnpike', city: 'Ridgefield Park', state: 'NJ', zip: '07660', hours: 'M-F, 6 am – 10 pm',
    domiciles: ['EWR45'], mileageByDomicile: { EWR45: 61.6 },
    prefTags: ['CDW5 Pref #1'], phone: '(201) 641-4440', contactPerson: 'Service',
    notes: 'Volvo, Mack, Kenworth, Hino, Ford, Isuzu. 11-bays. Has CNG tech, but shop is NOT CNG certified, so work is done outside.' },

  { name: 'North Jersey Truck Center, Inc.', makes: ['FREIGHTLINER', 'WESTERN STAR'],
    street: '236 Route 46 East', city: 'Saddle Brook', state: 'NJ', zip: '07663',
    domiciles: ['EWR45'], mileageByDomicile: { EWR45: 62.6 },
    phone: '(973) 478-8802', notes: 'Full Service; Uptime Pro' },

  // ── PHL40-first appearances ─────────────────────────────────────────────────
  { name: 'Freightliner Western Star Of Elkton', makes: ['FREIGHTLINER', 'WESTERN STAR'],
    street: '189 Belle Hill Rd', city: 'Elkton', state: 'MD', zip: '21921',
    domiciles: ['PHL40'], mileageByDomicile: { PHL40: 20.2 },
    phone: '(410) 441-3320', notes: 'Full Service; Roadside Repair' },

  { name: 'North East International Trucks (Beltway Co.)', makes: ['INTERNATIONAL', 'OTTAWA'],
    street: '1300 W Pulaski Hwy', city: 'Elkton', state: 'MD', zip: '21921',
    domiciles: ['PHL40'], mileageByDomicile: { PHL40: 25.4 },
    prefTags: ['BWI40 Pref #2'], phone: '410-469-6287', notes: 'Kalmar Ottawa, Cummins, Eaton, Allison' },

  { name: 'Dpc Emergency Equipment', makes: ['FREIGHTLINER', 'WESTERN STAR'],
    street: '335 Strauss Ave', city: 'Marydel', state: 'DE', zip: '19964',
    domiciles: ['PHL40'], mileageByDomicile: { PHL40: 43.9 },
    phone: '(302) 492-1245', notes: 'Parts & Services' },

  { name: 'Freightliner Western Star Of Lancaster', makes: ['FREIGHTLINER', 'WESTERN STAR'],
    street: '1675 Rohrerstown Road', city: 'Lancaster', state: 'PA', zip: '17601',
    domiciles: ['PHL40'], mileageByDomicile: { PHL40: 54.8 },
    phone: '(717) 581-3480', notes: 'Full Service; Roadside Repair' },

  { name: 'Kenworth of Lancaster', makes: ['KENWORTH'],
    street: '4030 Old Harrisburg Pike', city: 'Mount Joy', state: 'PA', zip: '17552',
    domiciles: ['PHL40'], mileageByDomicile: { PHL40: 60.0 },
    prefTags: ['PHL42 Pref #1'] },

  { name: 'Ascendance Truck Centers - Lancaster', makes: ['INTERNATIONAL', 'IC BUS'], mobile: true, cng: true, affiliation: 'Relay Garage/Reach',
    street: '1294 Strickler Road', city: 'Mount Joy', state: 'PA', zip: '17552', hours: 'M-F: 7a - 9p',
    domiciles: ['PHL40'], mileageByDomicile: { PHL40: 60.9 },
    phone: '(717) 492-0750', notes: 'All makes, Mobile Service' },

  { name: 'The Peterbilt Store - Baltimore', makes: ['PETERBILT'], mobile: true, affiliation: 'PACCAR',
    street: '5100 Holabird Ave', city: 'Baltimore', state: 'MD', zip: '21224', hours: 'Mon-Fri: 6am-6pm',
    domiciles: ['PHL40'], mileageByDomicile: { PHL40: 66.3 },
    prefTags: ['BWI40 Pref #1'], phone: '(410) 342-3400', notes: 'Dealer can send mobile tech or pickup unit depending on issue.' },

  { name: 'Easton Truck Center', makes: ['FREIGHTLINER', 'WESTERN STAR'],
    street: '9433 Ocean Gateway', city: 'Easton', state: 'MD', zip: '21601',
    domiciles: ['PHL40'], mileageByDomicile: { PHL40: 70.5 },
    phone: '(410) 690-3134', notes: 'Full Service' },

  // ── HBD1 (65 Holmes Rd, Newington, CT) — distances from HBD1 ────────────────
  { name: 'Gabrielli Truck Sales & Service - Hartford', makes: ['VOLVO', 'MACK', 'KENWORTH', 'HINO'], affiliation: 'PACCAR',
    street: '277 New Park Ave', city: 'Hartford', state: 'CT', zip: '06106', hours: 'M-F 7a-5:30p / Sa 7-12 / Su Closed',
    domiciles: ['HBD1'], mileageByDomicile: { HBD1: 3.2 },
    prefTags: ['ALARU01 Pref #1'], phone: '(860) 570-7060', email: 'kstephansen@gabriellitruck.com', contactPerson: 'Kevin Stephansen',
    notes: 'Volvo, Mack, Kenworth, Hino +' },

  { name: 'Allegiance Truck Centers - Hartford', makes: ['INTERNATIONAL', 'ISUZU', 'WABASH', 'DE', 'TROUT RIVER'], mobile: true, cng: true, affiliation: 'Relay Garage/Reach',
    street: '130 Brainard Rd', city: 'Hartford', state: 'CT', zip: '06114', hours: 'M-F: 8a - 5p, Sat: 8a - 12p',
    domiciles: ['HBD1'], mileageByDomicile: { HBD1: 4.7 },
    phone: '860-249-8635', notes: 'All makes, Mobile Service' },

  { name: 'Cummins East - Rocky Hill', makes: ['CUMMINS'],
    street: '914 Cromwell Avenue', city: 'Rocky Hill', state: 'CT', zip: '06067', hours: 'M-F 7a-4:30p / S&S- Closed',
    domiciles: ['HBD1'], mileageByDomicile: { HBD1: 5.5 },
    phone: '(860) 529-7474', email: 'kstephansen@gabriellitruck.com; ffurbish@gabriellitruck.com', contactPerson: 'Kevin Stephansen; Fredrick Furbish',
    notes: 'No Transmission Work- No Tech; CUMMINS Engine only- No Transmission Tech' },

  { name: 'The Peterbilt Store - Hartford', makes: [],
    street: '206 Meadow Ln', city: 'Berlin', state: 'CT', zip: '06037', hours: 'M-F 7AM-5PM',
    domiciles: ['HBD1'], mileageByDomicile: { HBD1: 7.2 },
    prefTags: ['ALARU01 Pref #2'], phone: '(860) 828-4125', email: 'help@thepetestore.com', contactPerson: 'Service',
    notes: 'Everything needed to repair' },

  { name: 'Ryder Rentals', makes: [],
    street: '185 West Service Rd', city: 'Hartford', state: 'CT', zip: '06120', hours: 'M-F 7a-4p / Sa 8a-12p / Su Closed',
    domiciles: ['HBD1'], mileageByDomicile: { HBD1: 7.3 },
    prefTags: ['JORC01 Specialist'], phone: '(860) 481-9719', notes: 'Do Not Schedule with Primary' },

  { name: 'Freightliner of Hartford', makes: [],
    street: '222 Roberts St.', city: 'East Hartford', state: 'CT', zip: '06108',
    domiciles: ['HBD1'], mileageByDomicile: { HBD1: 7.7 },
    prefTags: ['AREXE01 Pref #1'] },

  { name: 'Freightliner Of Hartford, Inc.', makes: ['FREIGHTLINER', 'WESTERN STAR'],
    street: '199 Roberts Street', city: 'East Hartford', state: 'CT', zip: '06108',
    domiciles: ['HBD1'], mileageByDomicile: { HBD1: 7.9 },
    phone: '(860) 289-0201', notes: 'Full Service; Uptime Pro; Roadside Repair' },

  { name: 'Carrier Transicold of Southern New England', makes: ['INDEPENDENT'], mobile: true,
    street: '551 West Johnson Avenue', city: '', state: '', zip: '',
    domiciles: ['HBD1'], mileageByDomicile: { HBD1: 12.8 },
    notes: 'TK & Carrier APU Service. Refer repair, Trailers. Tags: bodyshop, mobile, apu, reefer' },

  { name: 'Gabrielli Kenworth - Enfield', makes: ['KENWORTH'], affiliation: 'PACCAR',
    street: '1 Depot Hill Rd', city: 'Enfield', state: 'CT', zip: '06082', hours: 'M-F 6a-5p / Sa 6-12 / Su Closed',
    domiciles: ['HBD1'], mileageByDomicile: { HBD1: 17.6 },
    prefTags: ['ALARU01 Pref #2'], phone: '(860) 627-8030', email: 'cbradley@gabriellitruck.com', contactPerson: 'Chris Bradley' },

  { name: 'Allegiance Truck Centers - North Haven', makes: ['INTERNATIONAL', 'WABASH', 'DE', 'TROUT RIVER'], mobile: true, cng: true, affiliation: 'Relay Garage/Reach',
    street: '31 Leonardo Dr', city: 'North Haven', state: 'CT', zip: '06473', hours: 'M-F: 7a - 5p',
    domiciles: ['HBD1'], mileageByDomicile: { HBD1: 23.4 },
    phone: '203-239-0770', notes: 'All makes, Mobile Service' },

  { name: 'Allegiance Truck Centers - Springfield', makes: ['INTERNATIONAL', 'ISUZU', 'WABASH', 'DE', 'TROUT RIVER'], mobile: true, cng: true, affiliation: 'Relay Garage/Reach',
    street: '268 Park St', city: 'West Springfield', state: 'MA', zip: '01090', hours: 'M-F: 7a - 5p',
    domiciles: ['HBD1'], mileageByDomicile: { HBD1: 27.9 },
    phone: '413-732-2191', notes: 'All makes, Mobile Service' },

  { name: 'Ballard Truck Center - West Springfield MA', makes: ['VOLVO'], affiliation: 'Volvo Uptime',
    street: '124 Ashley Avenue', city: 'West Springfield', state: 'MA', zip: '01089',
    domiciles: ['HBD1'], mileageByDomicile: { HBD1: 28.4 },
    phone: '(508) 559-0771', contactPerson: 'Service' },

  { name: 'Black Rock Truck Group - Branford', makes: ['FREIGHTLINER'], affiliation: 'DTNA (Service Tracker)',
    street: '15 E Industrial Rd', city: 'Branford', state: 'CT', zip: '06405', hours: 'Mon-Sat 6:00-18:00',
    domiciles: ['HBD1'], mileageByDomicile: { HBD1: 28.5 },
    prefTags: ['ALARU01 Pref #3'], phone: '(800) 448-8480', email: 'jcogoli@blackrocktruck.com', contactPerson: 'John Cogoli' },

  { name: 'Allegiance Truck Centers - Southbury', makes: ['INTERNATIONAL', 'HINO', 'WABASH', 'DE', 'TROUT RIVER'], mobile: true, cng: true, affiliation: 'Relay Garage/Reach',
    street: '67 Main Street S', city: 'Southbury', state: 'CT', zip: '06488', hours: 'M-F: 7a - 5p, Sat: 8a - 12p',
    domiciles: ['HBD1'], mileageByDomicile: { HBD1: 29.2 },
    phone: '203-264-8251', notes: 'All makes, Mobile Service' },

  { name: 'Southern Connecticut Freightliner', makes: ['FREIGHTLINER', 'WESTERN STAR'],
    street: '15 East Industrial Road', city: 'Branford', state: 'CT', zip: '06405',
    domiciles: ['HBD1'], mileageByDomicile: { HBD1: 29.9 },
    phone: '(203) 481-0373', notes: 'Full Service; Uptime Pro' },

  { name: 'Atg Westfield', makes: ['FREIGHTLINER', 'WESTERN STAR'],
    street: '910 Southampton Road', city: 'Westfield', state: 'MA', zip: '01085',
    domiciles: ['HBD1'], mileageByDomicile: { HBD1: 31.9 },
    phone: '(413) 562-1037', notes: 'Full Service; Uptime Pro; Roadside Repair' },

  { name: 'Allegiance Truck Centers - Franklin', makes: ['INTERNATIONAL', 'ISUZU', 'WABASH', 'DE', 'TROUT RIVER'], mobile: true, cng: true, affiliation: 'Relay Garage/Reach',
    street: '6 New Park Ave', city: 'Franklin', state: 'CT', zip: '06254', hours: 'M-F: 8a - 5p, Sat: 8a - 12p',
    domiciles: ['HBD1'], mileageByDomicile: { HBD1: 33.2 },
    phone: '860-886-0593', notes: 'All makes, Mobile Service' },

  { name: 'Gabrielli Kenworth - Milford', makes: [],
    street: '312 Woodmont Rd', city: 'Milford', state: 'CT', zip: '06460', hours: 'M-T 5a-6p / F 7-5 / Sa 8-12 / Su Closed',
    domiciles: ['HBD1'], mileageByDomicile: { HBD1: 35.6 },
    phone: '(203) 876-5010', email: 'dfitzgerald@gabriellitruck.com', contactPerson: 'Deborah Fitzgerald' },

  { name: 'Gabrielli Truck Sales & Service - Milford', makes: ['ISUZU'], affiliation: 'PACCAR',
    street: '401 Old Gate Ln', city: 'Milford', state: 'CT', zip: '06460', hours: 'M-F 7a-5p / Sa 7-12 / Su Closed',
    domiciles: ['HBD1'], mileageByDomicile: { HBD1: 35.8 },
    prefTags: ['ALARU01 Pref #2'], phone: '(203) 877-3281', email: 'ffurbish@gabriellitruck.com', contactPerson: 'Fredrick Furbish' },

  { name: 'Allegiance Truck Centers - Northern Fairfield County', makes: ['MITSUBISHI-FUSO', 'ISUZU', 'FISHER', 'WABASH', 'DE', 'TROUT RIVER'], mobile: true, cng: true, affiliation: 'Relay Garage/Reach',
    street: '1 Turkey Plain Rd', city: 'Bethel', state: 'CT', zip: '06801', hours: 'M-F: 7:30a - 5p',
    domiciles: ['HBD1'], mileageByDomicile: { HBD1: 42.6 },
    phone: '(800) 378-4438', notes: 'All makes, Mobile Service' },

  { name: 'Allegiance Truck Centers - Danielson', makes: ['INTERNATIONAL', 'DE'], cng: true, affiliation: 'Relay Garage/Reach',
    street: '574 Wauregan Rd', city: 'Danielson', state: 'CT', zip: '06239', hours: 'M-F: 8a - 5p',
    domiciles: ['HBD1'], mileageByDomicile: { HBD1: 43.7 },
    phone: '860-779-2730', notes: 'All makes' },

  { name: 'Allegiance Truck Centers - Bridgeport', makes: ['INTERNATIONAL', 'WABASH', 'DE', 'TROUT RIVER'], mobile: true, cng: true, affiliation: 'Relay Garage/Reach',
    street: '1001 Wordin Ave', city: 'Bridgeport', state: 'CT', zip: '06605', hours: 'M-F: 7:30a - 5p',
    domiciles: ['HBD1'], mileageByDomicile: { HBD1: 44.9 },
    phone: '203-336-5387', notes: 'All makes, Mobile Service' },

  { name: 'Allegiance Truck Centers - Hudson Valley', makes: ['INTERNATIONAL', 'DE'], mobile: true, cng: true, affiliation: 'Relay Garage/Reach',
    street: '3609 US 9', city: 'Hudson', state: 'NY', zip: '12534', hours: 'M-F: 8a - 4:30p',
    domiciles: ['HBD1'], mileageByDomicile: { HBD1: 62.2 },
    phone: '(518) 851-3581', notes: 'All makes, Mobile Service' },

  { name: 'Dario Diesel Truck Center', makes: ['VOLVO', 'HINO', 'AUTOCAR'], affiliation: 'Volvo Uptime',
    street: '182 SW Cutoff', city: 'Worcester', state: 'MA', zip: '01604', hours: 'Mon-Fri: 7am - 5pm',
    domiciles: ['HBD1'], mileageByDomicile: { HBD1: 62.3 },
    prefTags: ['BOS42 Pref #2'], notes: 'Volvo, Hino, Autocar. NO CNG and NO BODY SHOP' },

  { name: 'Ballard Truck Center - Worcester MA', makes: ['VOLVO'], affiliation: 'Volvo Uptime',
    street: '442 Southwest Cutoff', city: 'Worcester', state: 'MA', zip: '01604',
    domiciles: ['HBD1'], mileageByDomicile: { HBD1: 63.5 },
    phone: '(508) 559-0771', contactPerson: 'Service' },

  { name: 'The Peterbilt Store - Rhode Island', makes: [],
    street: '11 Industrial Ln', city: 'Johnston', state: 'RI', zip: '02919', hours: '8:30am to 4pm',
    domiciles: ['HBD1'], mileageByDomicile: { HBD1: 64.1 },
    prefTags: ['BOS5 Pref #2'], phone: '(401) 351-0900', contactPerson: 'Service', notes: 'only OEM dealer in area for ottawa' },

  { name: 'Kenworth Northeast - Smithfield', makes: ['KENWORTH'], mobile: true, affiliation: 'PACCAR / Relay Garage/Reach',
    street: '170 Washington Hwy', city: 'Smithfield', state: 'RI', zip: '02917', hours: 'Mon-Fri: 7am-5pm',
    domiciles: ['HBD1'], mileageByDomicile: { HBD1: 64.1 },
    prefTags: ['BOS42 Pref #1'], notes: 'RG Integrated! Certified: CAT/Cummins/PACCAR.' },

  { name: 'Ballard Truck Center - Johnston RI', makes: ['VOLVO'],
    street: '280 Scituate Avenue', city: 'Johnston', state: 'RI', zip: '02919',
    domiciles: ['HBD1'], mileageByDomicile: { HBD1: 64.5 },
    phone: '(508) 559-0771', contactPerson: 'Service' },

  { name: 'Atg Tri State Truck Center, Llc', makes: ['FREIGHTLINER', 'WESTERN STAR'],
    street: '411 Hartford Turnpike', city: 'Shrewsbury', state: 'MA', zip: '01545',
    domiciles: ['HBD1'], mileageByDomicile: { HBD1: 65.1 },
    phone: '(508) 753-1200', notes: 'Full Service; Uptime Pro; Roadside Repair' },

  { name: 'Allegiance Truck Centers - Ronkonkoma', makes: ['INTERNATIONAL', 'WABASH', 'DE', 'AUTOCAR'], mobile: true, cng: true, affiliation: 'Relay Garage/Reach',
    street: '2222 Smithtown Avenue', city: 'Ronkonkoma', state: 'NY', zip: '11779', hours: 'M-F: 8a - 5p',
    domiciles: ['HBD1'], mileageByDomicile: { HBD1: 65.5 },
    phone: '631-981-1960', notes: 'All makes, Mobile Service' },

  { name: 'Allegiance Truck Centers - Shrewsbury', makes: ['INTERNATIONAL', 'DE'], cng: true, affiliation: 'Relay Garage/Reach',
    street: '545 Hartford Turnpike', city: 'Shrewsbury', state: 'MA', zip: '01545', hours: 'M-F: 8a - 6p',
    domiciles: ['HBD1'], mileageByDomicile: { HBD1: 65.8 },
    phone: '(508) 734-6061', notes: 'All makes' },

  { name: 'Long Island Freightliner', makes: ['FREIGHTLINER', 'WESTERN STAR'],
    street: '1365 Lakeland Avenue', city: 'Bohemia', state: 'NY', zip: '11716',
    domiciles: ['HBD1'], mileageByDomicile: { HBD1: 67.1 },
    phone: '(631) 563-1300', notes: 'Full Service' },

  { name: 'Brodie Toyota Lift - Shrewsbury MA', makes: ['TOYOTA'],
    street: '173 Memorial Drive, Unit C', city: 'Shrewsbury', state: 'MA', zip: '01545',
    domiciles: ['HBD1'], mileageByDomicile: { HBD1: 65.6 },
    notes: 'Forklift / lift service' },

  { name: 'Walser Mobile Refrigeration', makes: [],
    street: '110 Brownlee Blvd', city: 'Warwick', state: 'RI', zip: '02886',
    domiciles: ['HBD1'], mileageByDomicile: { HBD1: 66.6 },
    notes: 'APU Service. Tags: apu' },

  // ── ROC5 (90 Shepard Rd, Rochester, NY) — distances from ROC5 ───────────────
  { name: 'Kenworth Northeast - Rochester', makes: ['KENWORTH'], mobile: true, cng: true, affiliation: 'PACCAR / Relay Garage/Reach',
    street: '25 Airline Dr', city: 'Rochester', state: 'NY', zip: '14624', hours: 'Mon-Fri: 6am-11:30pm | Sat: 7am-3:30pm',
    domiciles: ['ROC5'], mileageByDomicile: { ROC5: 5.1 },
    notes: 'RG Integrated! Certified: CAT/Cummins/PACCAR. Alignment' },

  { name: 'Tracey Road Equipment, Inc.', makes: ['FREIGHTLINER', 'WESTERN STAR'],
    street: '300 Middle Road', city: 'Henrietta', state: 'NY', zip: '14467',
    domiciles: ['ROC5'], mileageByDomicile: { ROC5: 6.8 },
    phone: '(585) 334-5120', notes: 'Full Service; Uptime Pro; Roadside Repair' },

  { name: 'Freightliner & Western Star Of Batavia Llc', makes: ['FREIGHTLINER', 'WESTERN STAR'],
    street: '8190 State Street Road', city: 'Batavia', state: 'NY', zip: '14020',
    domiciles: ['ROC5'], mileageByDomicile: { ROC5: 30.1 },
    phone: '(585) 524-2100', notes: 'Full Service; Uptime Pro; Roadside Repair' },

  { name: 'Cummins East - Buffalo', makes: ['CUMMINS'],
    street: '700 Aero Drive', city: 'Buffalo', state: 'NY', zip: '14225',
    domiciles: ['ROC5'], mileageByDomicile: { ROC5: 57.5 },
    phone: '716-829-1700' },

  { name: 'Fleet Maintenance, Inc.', makes: ['FREIGHTLINER', 'WESTERN STAR'], affiliation: 'DTNA (Service Tracker)',
    street: '67 Ransier Dr', city: 'Buffalo', state: 'NY', zip: '14224',
    domiciles: ['ROC5'], mileageByDomicile: { ROC5: 61.0 },
    phone: '(716) 675-9220', notes: 'Full Service; Uptime Pro; Roadside Repair. Cert: Cummins, Eaton, Allison' },

  { name: 'Kenworth Northeast - Buffalo', makes: ['KENWORTH'], mobile: true, cng: true, affiliation: 'PACCAR / Relay Garage/Reach',
    street: '100 Commerce Dr', city: 'Buffalo', state: 'NY', zip: '14218', hours: 'Mon-Fri: 6am-11:30pm | Sat: 7am-3:30pm',
    domiciles: ['ROC5'], mileageByDomicile: { ROC5: 66.3 },
    notes: 'RG Integrated! Certified: CAT/Cummins/PACCAR. Alignment' },

  { name: 'Allegiance Truck Centers - Syracuse', makes: ['INTERNATIONAL', 'ISUZU', 'DE', 'AUTOCAR'], mobile: true, cng: true, affiliation: 'Relay Garage/Reach',
    street: '105 7th North Street', city: 'Liverpool', state: 'NY', zip: '13088', hours: 'M-F: 8a - 5p',
    domiciles: ['ROC5'], mileageByDomicile: { ROC5: 73.3 },
    phone: '(315) 475-8471', notes: 'All makes, Body Shop, Mobile Service' },

  { name: 'Kenworth Northeast - Syracuse', makes: ['KENWORTH'], mobile: true, affiliation: 'PACCAR / Relay Garage/Reach',
    street: '6687 Moore Rd', city: 'Syracuse', state: 'NY', zip: '13211', hours: 'Mon-Fri: 7am-11pm | Sat: 7am-3:30pm',
    domiciles: ['ROC5'], mileageByDomicile: { ROC5: 76.1 },
    notes: 'RG Integrated! Certified: CAT/Cummins/PACCAR. Alignment' },

  { name: 'Cummins East - Syracuse', makes: ['CUMMINS'],
    street: '6193 Eastern Avenue', city: 'Syracuse', state: 'NY', zip: '13211',
    domiciles: ['ROC5'], mileageByDomicile: { ROC5: 77.0 },
    phone: '315-437-2751' },
];

// Genuine same-dealer matches whose EXISTING card uses a different name. Keyed
// by import name -> existing card name, so the record merges onto that card
// (adds domiciles/mileage/CNG/etc.) instead of creating a near-duplicate.
// Confirmed by matching address/city, not just name.
const ALIAS_TO_EXISTING = {
  'Gabrielli Truck Sales & Service - Bloomsbury': 'Gabrielli Truck Sales - Bloomsbury NJ',
  "Bergey's Truck Centers - Souderton": "BERGEY'S TRUCK CENTER Souderton",
  'Cummins East - Bristol': 'Cummins Bristol',
  'Coopersburg Kenworth': 'Gabrielli Truck Sales - Coopersburg',
};

// ── Importer ────────────────────────────────────────────────────────────────
function main() {
  const apply = process.argv.includes('--apply');

  // Resolve the REAL userData dir (same as the running app). Under electron,
  // app.getPath('userData') is correct; fall back only if not in electron.
  let paths;
  try {
    paths = require(path.join(__dirname, '..', 'src', 'config', 'paths'));
    // Resolve the SAME userData dir the app uses. Order: electron app.getPath
    // (if truly running under electron) > --data-dir arg > FLEET_DATA_DIR env >
    // the platform default (APPDATA/fleet-ops-app on win32). A plain `node` run
    // would otherwise resolve to ~/.fleet-ops (wrong file), so we pin it here.
    let dataDir = null;
    try {
      const { app } = require('electron');
      if (app && typeof app.getPath === 'function') dataDir = app.getPath('userData');
    } catch (_) {}
    const argI = process.argv.indexOf('--data-dir');
    if (argI > -1 && process.argv[argI + 1]) dataDir = process.argv[argI + 1];
    if (!dataDir && process.env.FLEET_DATA_DIR) dataDir = process.env.FLEET_DATA_DIR;
    if (!dataDir) {
      const os = require('os');
      if (process.platform === 'win32' && process.env.APPDATA) dataDir = path.join(process.env.APPDATA, 'fleet-ops-app');
      else if (process.platform === 'darwin') dataDir = path.join(os.homedir(), 'Library', 'Application Support', 'fleet-ops-app');
      else dataDir = path.join(os.homedir(), '.config', 'fleet-ops-app');
    }
    paths.setDataDir(dataDir);
  } catch (e) {
    console.error('Could not load src/config/paths:', e.message);
    process.exit(1);
  }

  const store = require(path.join(__dirname, '..', 'src', 'store'));
  const cb = require(path.join(__dirname, '..', 'src', 'services', 'contact-book'));

  const before = store.load('contacts', []);
  const existingVendors = (Array.isArray(before) ? before : []).filter(c => c && c.type === 'vendor');

  // Classify each import record against existing vendors, so a dry-run shows
  // exactly what will happen. "possible duplicate" = a close-but-not-exact name
  // the auto-dedupe will NOT merge (so it would create a new card unless the
  // user intervenes). We use the service's own key for the exact/fuzzy match
  // and a looser token-overlap heuristic for the "possible" warning.
  const key = cb._vendorNameKey;
  const existKeys = new Map(existingVendors.map(v => [key(v.name), v.name]));
  const normCity = s => String(s || '').trim().toLowerCase();
  // Drop generic chain words so overlap reflects the DISTINCTIVE brand, not
  // shared filler like "truck/centers/service/inc".
  const GENERIC = new Set(['truck', 'trucks', 'center', 'centers', 'service', 'services',
    'sales', 'inc', 'llc', 'co', 'company', 'of', 'and', 'the', 'pa', 'nj', 'ny', 'de', 'md']);
  const tokens = s => new Set(key(s).split(' ').filter(w => w.length > 2 && !GENERIC.has(w)));
  // A real possible-duplicate: distinctive-token overlap AND the SAME city
  // (so "Bergey's ... Souderton" vs existing "BERGEY'S ... Souderton" flags,
  // but "Bergey's Pennsauken" vs "Bergey's Reading" does NOT).
  const looksClose = (impRec, existRec) => {
    const ta = tokens(impRec.name), tb = tokens(existRec.name);
    if (!ta.size || !tb.size) return false;
    let inter = 0; ta.forEach(w => { if (tb.has(w)) inter++; });
    if (inter < 1) return false;
    const ci = normCity(impRec.city), ce = normCity(existRec.city);
    // Same city (or existing has no city on file) is required to avoid flagging
    // different branches of the same chain as duplicates.
    return ci && ce ? ci === ce : true;
  };

  const willMerge = [];   // exact/fuzzy key match -> auto-merges onto existing
  const possible = [];    // close name but won't auto-merge -> would create new
  const brandNew = [];    // no similar existing vendor

  for (const v of VENDORS) {
    const k = key(v.name);
    if (ALIAS_TO_EXISTING[v.name]) { willMerge.push({ v, onto: ALIAS_TO_EXISTING[v.name] + ' (alias)' }); continue; }
    if (existKeys.has(k)) { willMerge.push({ v, onto: existKeys.get(k) }); continue; }
    const near = existingVendors.find(e => looksClose(v, e));
    if (near) possible.push({ v, near: near.name });
    else brandNew.push(v);
  }

  console.log('\n=== DEALER IMPORT ' + (apply ? '(APPLY)' : '(DRY-RUN — nothing written)') + ' ===');
  console.log('contacts.json: ' + store.REGISTRY.contacts());
  console.log('Existing vendors: ' + existingVendors.length + ' | Import records: ' + VENDORS.length + '\n');

  console.log('— ' + brandNew.length + ' NEW vendors (no existing match):');
  brandNew.forEach(v => console.log('   + ' + v.name + '  [' + (v.domiciles || []).join(',') + ']'));

  console.log('\n— ' + willMerge.length + ' will MERGE onto an existing vendor (same name):');
  willMerge.forEach(m => console.log('   ~ ' + m.v.name + '  ->  ' + m.onto));

  console.log('\n— ' + possible.length + ' POSSIBLE DUPLICATES (close name, will NOT auto-merge -> would add a NEW card):');
  possible.forEach(p => console.log('   ? import "' + p.v.name + '"  vs existing "' + p.near + '"'));

  if (!apply) {
    console.log('\nDry-run only. Re-run with --apply to write. Review the POSSIBLE DUPLICATES above first.');
    return;
  }

  // Apply: upsert every record. The service auto-merges exact/fuzzy name matches
  // and unions domiciles/makes/mileage. The 4 ALIAS_TO_EXISTING records are
  // renamed to their existing card name first, so they merge onto that card.
  let added = 0, merged = 0, aliasMerged = 0;
  const curAll = store.load('contacts', []);
  const byName = new Map((Array.isArray(curAll) ? curAll : [])
    .filter(c => c && c.type === 'vendor').map(c => [key(c.name), c]));

  for (const v of VENDORS) {
    const rec = Object.assign({ type: 'vendor' }, v);
    rec.make = (v.makes && v.makes[0]) || '';

    const existingName = ALIAS_TO_EXISTING[v.name];
    const existing = existingName && byName.get(key(existingName));
    if (existing) {
      // Build ONE final object merged onto the existing card, then write it
      // verbatim (match by id, mergeNoBlank:false). Union the multi-value
      // fields by hand; keep the user's name + preference; fill scalars from
      // the import where the existing card is blank; OR the capability flags.
      const uniq = (...arrs) => {
        const out = [], seen = new Set();
        arrs.forEach(a => (a || []).forEach(x => { const s = String(x || '').trim(); const k = s.toUpperCase(); if (s && !seen.has(k)) { seen.add(k); out.push(s.toUpperCase()); } }));
        return out;
      };
      const final = Object.assign({}, existing);
      final.name = existing.name;
      final.domiciles = uniq(existing.domiciles, v.domiciles);
      final.makes = uniq(existing.makes && existing.makes.length ? existing.makes : (existing.make ? [existing.make] : []), v.makes);
      final.make = final.makes[0] || existing.make || '';
      final.mileageByDomicile = Object.assign({}, existing.mileageByDomicile || {}, v.mileageByDomicile || {});
      if (v.prefTags) final.prefTags = uniq(existing.prefTags, v.prefTags);
      // Fill blank scalars from the import; never blank an existing value.
      ['company', 'street', 'city', 'state', 'zip', 'phone', 'email', 'affiliation', 'hours', 'contactPerson', 'notes']
        .forEach(k => { if ((existing[k] == null || existing[k] === '') && v[k]) final[k] = v[k]; });
      final.cng = !!(existing.cng || v.cng);
      final.mobile = !!(existing.mobile || v.mobile);
      const res = cb.upsert(final, { mergeNoBlank: false, vendorUnion: false });
      if (res && res.ok) aliasMerged++;
      continue;
    }

    const res = cb.upsert(rec);
    if (res && res.ok) { if (res.contact && existKeys.has(key(res.contact.name))) merged++; else added++; }
  }
  merged += aliasMerged;
  const after = store.load('contacts', []);
  const afterVendors = (Array.isArray(after) ? after : []).filter(c => c && c.type === 'vendor');
  console.log('\nApplied. Vendors: ' + existingVendors.length + ' -> ' + afterVendors.length);
  console.log('Done. Restart the app (or it will pick up contacts:updated) to see the cards.');
}

main();
module.exports = { VENDORS };

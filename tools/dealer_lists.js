'use strict';
/**
 * dealer_lists.js — raw dealer-locator text, one block per domicile.
 *
 * This is the verbatim text the user pasted from the dealer-locator tool for
 * each of the four managed domiciles. The distances in each block are measured
 * FROM that domicile. import_dealers.js parses these into vendor records,
 * dedupes across all four, and accumulates per-domicile mileage.
 *
 * To refresh: replace a block's text with a fresh paste and re-run the importer.
 * "⛔ Do Not Use" entries are intentionally LEFT IN the raw text — the parser
 * detects and skips them, so the exclusion is auditable here.
 */

// NOTE: distances in each block are from the domicile named by the key.
const LISTS = {
  AVP40: String.raw`
Hunter Truck - Scranton
🚛 0 units assigned
🔧 Peterbilt, PacLease
🔗 Affiliation: PACCAR
AVP40 Pref #1
📍 2900 Stafford Ave, Scranton, PA 18505, Scranton, PA
🏷️ bodyshop
📞 N/A
📍 4.3 miles
M&K Truck Centers - Scranton
🚛 0 units assigned
🔧 Mobile Service Available
🔧 Volvo, Mack, Hino
AVP40 Pref #1
📍 125 Monahan Ave, Dunmore, PA 18512, Dunmore, PA
🏷️ mobile
📞 N/A
📍 9.7 miles
Ascendance Truck Centers - Allentown ⭐⭐⭐⭐⭐
🚛 0 units assigned
🔧 Mobile Service Available
🔧 International, Idealease, IC Bus
🔗 Integration: Relay Garage/Reach
✅ Integrated via Relay Garage/Reach — assign directly in RG (no brokering needed).
AVP40 Pref #1
📍 2131 Hanover Avenue, Allentown, PA 18109, Allentown, PA
🕐 M-F: 7a - 9p
All makes, Mobile Service, Reach on-boarding in progress. Supporting ABE/AVP locations
🏷️ mobile, cng
📞 (484) 661-4193
📍 51.6 miles
PUSH & PULL
🚛 0 units assigned
🔧 Freightliner
AVP40 Pref #1
📍 4749 GRAMMES RD ALLENTOWN PA 18104, ,
📞 N/A
📍 53.8 miles
Gabrielli Truck Sales & Service - Bloomsbury
🚛 1 unit assigned
🔧 Volvo, Mack, Kenworth, Hino +
🔗 Affiliation: PACCAR
AVP40 Pref #1
📍 963 Route 173, Bloomsbury, NJ 08804, Bloomsbury, NJ
🕐 Mon-Fri: 8 am - 6 pm
Volvo, Mack, Kenworth, Hino +. Towing, Body shop.
🏷️ bodyshop
📞 908-479-4970 ext. 3230 | ✉️ mwolverton@gabriellitruck.com | 👤 Service Dept - Makayla Wolverton
📍 57.9 miles
Bergey's Truck Centers - Souderton
🚛 0 units assigned
🔧 Volvo, Mack
🔗 Affiliation: Volvo Uptime
AVP40 Pref #1
📍 446 Harleysville Pike, Souderton, PA 18964, Souderton, PA
📞 N/A
📍 74.6 miles
Allegiance Truck Centers - Scranton Unassigned
🚛 0 units assigned
🔧 Mobile Service Available
🔧 International, Autocar
🔗 Integration: Relay Garage/Reach
✅ Integrated via Relay Garage/Reach — assign directly in RG (no brokering needed).
📍 1006 Underwood Road, Olyphant, PA 18447, Olyphant, PA
🕐 M-F: 8a - 5p
All makes, Mobile Service
🏷️ mobile, cng
📞 (570) 941-3600
📍 11.3 miles
Sherwood Freightliner & Western Star, Inc.
🚛 0 units assigned
🔧 Freightliner/Western Star
📍 5578 SR 6, TUNKHANNOCK, PA 18657, Tunkhannock, PA
Full Service; Roadside Repair
📞 (570) 836-5027
📍 17.9 miles
Horwith Trucks Inc
🚛 0 units assigned
🔧 Freightliner
ABE3 Pref #3
📍 1449 Nor Bath Blvd, Northampton, PA 18067, Northampton, PA
🕐 Mon – Fri: 7:00am – 11:30pm / 7AM–12PM
freightliner
📞 (610) 261-2220
📍 46.0 miles
Doctor Diesel. PA
🚛 0 units assigned
ACY2 Pref #2
📍 4822 Kernsville Rd, Orefield, PA 18069, Orefield, PA
🕐 M-F, 8AM - 7PM
Everything needed to repair daycabs to OEM spec
📞 (929) 398-8928 | ✉️ joey@docdiesel.com | 👤 John Tluczek
📍 48.8 miles
Transedge Truck Centers - Allentown
🚛 2 units assigned
🔧 Volvo/Mack/Hino
ABE2 Pref #2
📍 1407 Bulldog Drive, Allentown, PA 18104, Allentown, PA
🕐 Mon – Fri: 7:00am – 08:00pm Sat: 8AM–12PM
Makes: Volvo/Mack/Hino
📞 (610) 395-6801 | ✉️ tom.epting@transedgetruck.com | 👤 Service Manager: Matt Gerecht
📍 51.1 miles
Hunter Truck - Allentown
🚛 0 units assigned
🔧 Peterbilt
🔗 Affiliation: PACCAR
HDC3 Pref #2
📍 9981 Old U.S. 22, Breinigsville, PA 18031, Breinigsville, PA
🕐 Mon – Fri7 am – 12 am Sat8 am – 4 pm
delaer
📞 (610) 285-2244 | ✉️ nstettler@huntertrucksales.com | 👤 Nate Stettler
📍 52.1 miles
Allegiance Truck Centers - Binghamton Unassigned
🚛 0 units assigned
🔧 Mobile Service Available
🔧 International, DE, Autocar
🔗 Integration: Relay Garage/Reach
✅ Integrated via Relay Garage/Reach — assign directly in RG (no brokering needed).
📍 582 Conklin Road, Binghamton, NY 13903, Binghamton, NY
🕐 M-F: 8a - 5p
All makes, Mobile Service
🏷️ cng, mobile
📞 (607) 724-9125
📍 53.5 miles
W. Campbell Supply Company Of Sussex County, Llc
🚛 0 units assigned
🔧 Freightliner/Western Star
📍 2 ROUTE 94, LAFAYETTE, NJ 07848, Lafayette, NJ
Parts & Services; Uptime Pro
📞 (973) 756-1600
📍 57.3 miles
Kenworth of PA - Shartlesville ⭐
🚛 0 units assigned
🔧 Kenworth
🔗 Affiliation: PACCAR
AVP8 Pref #2
📍 16 Motel Dr, Shartlesville, PA 19554, Shartlesville, PA
Eaton
📞 N/A
📍 59.5 miles
Coopersburg Kenworth
🚛 0 units assigned
🔧 Mobile Service Available
🔧 Kenworth
🔗 Affiliation: PACCAR
ABE2 Pref #1
📍 1930 PA-309, Coopersburg, PA 18036, Coopersburg, PA
🕐 M-F 7am-11pm Saturday 7am-12pm
Mobile Maint. Kenworth/Peterbilt, Cummins, PACCAR certified. Eaton trans and body shop
🏷️ bodyshop, cummins, mobile
📞 (609)802-6535; (610) 282-4500 | ✉️ ttrembler@coopskw.com | 👤 Mobile Tech Manager Matthew Agati; Tracy Trembler, Service Manager
📍 60.3 miles
Robert H. Hoover & Sons, Inc.
🚛 0 units assigned
🔧 Freightliner/Western Star
📍 149 GOLD MINE ROAD, FLANDERS, NJ 07836, Flanders, NJ
Full Service; Uptime Pro
📞 (973) 347-4210
📍 62.6 miles
Berman Truck Group
🚛 1 unit assigned
🔧 Freightliner/Western Star
🔗 Affiliation: DTNA (Service Tracker)
📍 175 LEGION DRIVE, BETHEL, PA 19507, BETHEL, PA
Parts & Services; Uptime Pro; Roadside Repair
📞 (717) 933-5656
📍 65.4 miles
Ascendance Truck Centers - Reading Unassigned
🚛 0 units assigned
🔧 Mobile Service Available
🔧 International, IC Bus
🔗 Integration: Relay Garage/Reach
✅ Integrated via Relay Garage/Reach — assign directly in RG (no brokering needed).
📍 1846 N. 5th Street, Reading, PA 19601, Reading, PA
🕐 M-F: 7a - 5p
All makes, Mobile Service
🏷️ mobile, cng
📞 (610) 370-8165
📍 67.5 miles
Cummins East - Williamsport Unassigned
🚛 0 units assigned
🔧 Cummins
📍 2683 Lycoming Creek Road, Williamsport, PA 17701, Williamsport, PA
🏷️ cummins
📞 570-505-3020
📍 68.1 miles
Ascendance Truck Centers - Williamsport Unassigned
🚛 0 units assigned
🔧 Mobile Service Available
🔧 International, IC Bus
🔗 Integration: Relay Garage/Reach
✅ Integrated via Relay Garage/Reach — assign directly in RG (no brokering needed).
📍 2751 McCoy Street, Williamsport, PA 17707, Williamsport, PA
🕐 M-F: 7a - 5p
All makes, Mobile Service
🏷️ mobile, cng
📞 (570) 601-6765
📍 68.2 miles
Gabrielli Truck Sales & Service - Rockaway Unassigned
🚛 0 units assigned
🔧 Volvo, Mack, Kenworth, Hino +
🔗 Affiliation: PACCAR
📍 80 Green Pond Road, Rockaway, NJ 07866, Rockaway, NJ
Volvo, Mack, Kenworth, Hino +
📞 N/A
📍 70.9 miles
`,
};

module.exports = { LISTS };

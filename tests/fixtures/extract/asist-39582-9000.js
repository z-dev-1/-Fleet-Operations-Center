// Newest-first formatted asistNotes of ~9,000 chars (39582 shape; head: Uptime ETR 11/11/2026).
// Names and phones masked. The tail (oldest) entries carry an older ETC so a tail-reading
// clip would show the wrong (old) status.
'use strict';

const HEAD = '2026-11-10 10:28 Uptime Center (Originator: Uptime): Current Case \u2014 ETR is 11/11/2026. Waiting on parts install, all parts arrived 11/04.';

function _filler() {
  const out = [];
  let len = 0;
  for (let k = 0; len < 8200; k++) {
    const day = 9 - (k % 9);
    const line = '2026-11-0' + day + ' 0' + (k % 9) + ':1' + (k % 6) + ' Dealer Advisor (M & K): Status \u2014 Waiting on parts; '
      + 'harness Part # 85152780 tracking requested from Volvo parts, entry ' + k + ', no change to the repair plan.';
    out.push(line);
    len += line.length + 1;
  }
  return out;
}
const TAIL = '2026-09-28 18:05 Dealer Advisor (M & K): Parts info \u2014 RO # 30319SP, ETC 10/15 (old estimate)';

const lines = [HEAD].concat(_filler(), [TAIL]);
const asistNotes = lines.join('\n');

module.exports = { asistNotes, HEAD, TAIL };

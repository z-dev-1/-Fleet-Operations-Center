/**
 * setup.js -- Setup wizard renderer entry point
 *
 * Steps:
 *   1. Profile   (name, email, phone)
 *   2. Domiciles (comma/newline separated codes)
 *   3. Midway    (run mwinit check)
 *   4. Orcha     (mode, host, port)
 *   5. Confirm   (review + complete)
 *
 * On 'Complete', fires ipcRenderer send 'wizard:complete' via window.setup.complete()
 * which triggers window.index.js to close wizard + open main window.
 */

const STEPS = [
  {
    id:    'profile',
    title: 'Your Profile',
    html:  `
      <label>Full Name <input id="sw-name" type="text" class="setup__input" placeholder="Jane Smith" /></label>
      <label>Amazon Email <input id="sw-email" type="email" class="setup__input" placeholder="jansmith@amazon.com" /></label>
      <label>Phone (optional) <input id="sw-phone" type="tel" class="setup__input" placeholder="+1 555 0100" /></label>
    `,
    collect: () => ({
      userName:  document.getElementById('sw-name').value.trim(),
      userEmail: document.getElementById('sw-email').value.trim(),
      userPhone: document.getElementById('sw-phone').value.trim(),
    }),
  },
  {
    id:    'domiciles',
    title: 'Your Domicile Sites',
    html:  `
      <p class="setup__hint">Enter your domicile site codes, one per line (e.g. ABE40).</p>
      <textarea id="sw-domiciles" class="setup__textarea" rows="5" placeholder="ABE40&#10;EWR45&#10;PHL40"></textarea>
    `,
    collect: () => ({
      domiciles: document.getElementById('sw-domiciles').value,
    }),
  },
  {
    id:    'midway',
    title: 'Midway Authentication',
    html:  `
      <p class="setup__hint">Fleet Operations requires Midway (mwinit) for internal tool access.</p>
      <div id="sw-midway-status" class="setup__status">Not checked yet</div>
      <button id="sw-run-mwinit" class="setup__btn">Check / Run mwinit</button>
    `,
    collect: () => ({}),
    afterMount: () => {
      document.getElementById('sw-run-mwinit').addEventListener('click', async () => {
        document.getElementById('sw-midway-status').textContent = 'Running mwinit...';
        try {
          const r = await window.auth.runMwinit();
          document.getElementById('sw-midway-status').textContent =
            r && r.ok ? 'Midway OK' : ('Failed: ' + (r && r.reason || 'unknown'));
        } catch (e) {
          document.getElementById('sw-midway-status').textContent = 'Error: ' + e.message;
        }
      });
    },
  },
  {
    id:    'orcha',
    title: 'Orcha AI Config',
    html:  `
      <label>Mode
        <select id="sw-orcha-mode" class="setup__select">
          <option value="local">Local (Ollama)</option>
          <option value="remote">Remote host</option>
          <option value="bedrock">Amazon Bedrock</option>
        </select>
      </label>
      <label>Host (if remote) <input id="sw-orcha-host" class="setup__input" type="text" placeholder="localhost" /></label>
      <label>Port <input id="sw-orcha-port" class="setup__input" type="number" placeholder="4799" /></label>
    `,
    collect: () => ({
      orchaMode: document.getElementById('sw-orcha-mode').value,
      orchaHost: document.getElementById('sw-orcha-host').value.trim(),
      orchaPort: parseInt(document.getElementById('sw-orcha-port').value, 10) || 4799,
    }),
  },
  {
    id:    'confirm',
    title: 'Review & Complete',
    html:  `<div id="sw-confirm-summary" class="setup__summary">Loading summary...</div>`,
    afterMount: (config) => {
      const el = document.getElementById('sw-confirm-summary');
      if (el) {
        el.innerHTML = Object.entries(config)
          .filter(([, v]) => v)
          .map(([k, v]) => '<div><strong>' + k + '</strong>: ' + v + '</div>')
          .join('');
      }
    },
    collect: () => ({}),
  },
];

let _currentStep = 0;
const _config    = {};

const mountEl  = document.getElementById('setup-mount');
const titleEl  = document.querySelector('.setup-header .setup-version');

function render() {
  const step = STEPS[_currentStep];
  if (!mountEl || !step) return;

  if (titleEl) titleEl.textContent = 'Step ' + (_currentStep + 1) + ' of ' + STEPS.length + ': ' + step.title;

  mountEl.innerHTML = `
    <div class="setup-step">
      <div class="setup-step__body">${step.html}</div>
      <div class="setup-step__footer">
        ${_currentStep > 0 ? '<button id="sw-back" class="setup__btn setup__btn--secondary">Back</button>' : ''}
        <button id="sw-next" class="setup__btn">
          ${_currentStep < STEPS.length - 1 ? 'Next' : 'Complete Setup'}
        </button>
      </div>
    </div>
  `;

  // Restore saved values
  const saved = _config[step.id] || {};
  Object.entries(saved).forEach(([k, v]) => {
    const el = document.getElementById('sw-' + k.replace(/([A-Z])/g, (m) => '-' + m.toLowerCase()));
    if (el) el.value = v;
  });

  if (step.afterMount) step.afterMount(_config);

  if (_currentStep > 0) {
    document.getElementById('sw-back').addEventListener('click', () => {
      _currentStep--;
      render();
    });
  }

  document.getElementById('sw-next').addEventListener('click', async () => {
    const collected = step.collect ? step.collect() : {};
    Object.assign(_config, collected);
    _config[step.id] = collected;

    if (_currentStep < STEPS.length - 1) {
      _currentStep++;
      render();
    } else {
      // Complete
      try {
        await window.setup.complete();
        // window.index.js listens for wizard:complete and handles the rest
      } catch (e) {
        console.error('Setup complete error:', e);
      }
    }
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', render);
} else {
  render();
}

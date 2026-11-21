// "Respect is Everything." - one calm line centred on screen when the car enters the Holocaust
// memorial's no-drive zone (js/nodrive.js, zone name MEMORIAL; index.html noDriveStart calls
// show()). The owner's deliberate exception to the quiet-game rule (README Rules), 2026-11-21.
// White lettering in the normal UI sans, soft dark shadow, no plate, no emoji; fade in 0.6 s,
// hold 4 s, fade out 1.2 s; at most once per opts.gap s (real clock: shows even while the game
// is paused or the map closes for the rescue).
//
//   const respect = createRespectLine();   respect.show()   // berlinDrive.respectLine.show()

export const MEMORIAL = 'Denkmal für die ermordeten Juden Europas';
export const RESPECT_TEXT = 'Respect is Everything.';

export function createRespectLine({ parent = document.body } = {}) {
  const opts = { fadeIn: 0.6, hold: 4, fadeOut: 1.2, gap: 20 };
  const style = document.createElement('style');
  style.textContent = `
#respect { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); z-index: 2700;
  max-width: calc(100vw - 32px); box-sizing: border-box; text-align: center; pointer-events: none;
  font: 600 clamp(22px, 3.2vw, 34px) system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: #fff;
  text-shadow: 0 1px 3px rgba(0, 0, 0, 0.75), 0 0 18px rgba(0, 0, 0, 0.55); opacity: 0; visibility: hidden; }
#respect.on { opacity: 1; visibility: visible; }`;
  document.head.appendChild(style);
  const el = document.createElement('div');
  el.id = 'respect';
  el.setAttribute('role', 'status');
  el.textContent = RESPECT_TEXT;
  parent.appendChild(el);
  let lastAt = -Infinity, hideT = 0;
  function show(force = false) {
    const now = performance.now();
    if (!force && now - lastAt < opts.gap * 1000) return false;
    lastAt = now;
    clearTimeout(hideT);
    el.style.transition = `opacity ${opts.fadeIn}s ease-out, visibility 0s`;
    el.classList.add('on');
    hideT = setTimeout(() => {
      el.style.transition = `opacity ${opts.fadeOut}s ease-in, visibility 0s linear ${opts.fadeOut}s`;
      el.classList.remove('on');
    }, (opts.fadeIn + opts.hold) * 1000);
    return true;
  }
  return { show: () => show(true), trigger: () => show(false), opts };
}

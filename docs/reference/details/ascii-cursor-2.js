function initAsciiWind2(scope = document, variant = 'wind') {
  const document = scope.ownerDocument || scope;
  const window = document.defaultView;
  if (!window) return () => {};
  const focusWindow = (() => {
    try { return window.top?.document ? window.top : window; }
    catch { return window; }
  })();

  const modes = {
    wind: { base: 0.26, rest: 0.03, friction: 0.6, flick: 1.2, revealS: 4, headroom: 3, calmX: 250, calmY: 80, quiet: 0.3 },
    capillary: { base: 0.3, rest: 0.008, friction: 0.25, flick: 0.7, revealS: 2.2, headroom: 2.5, calmX: 250, calmY: 80, quiet: 0.7 },
    estuary: { base: 0.30, rest: 0.008, friction: 0.6, flick: 1.2, revealS: 4, headroom: 2.5, calmX: 170, calmY: 55, quiet: 0.75 },
  };
  if (!Object.prototype.hasOwnProperty.call(modes, variant)) throw new RangeError(`Unknown ASCII Cursor 2.0 variant: ${variant}`);
  const mode = modes[variant];
  const config = {
    strength: { scale: 1, base: { dark: mode.base, light: mode.base }, cap: { dark: 0.9, light: 0.9 }, rest: mode.rest },
    surface: { fill: 1, weight: 300, glyphCss: 9, skipUnseen: true },
    wind: { energy: 1, friction: mode.friction, flick: mode.flick, lull: 0.5, streak: 0.4, detail: 0.6, edge: 0.75, curl: 0.65, wisp: 0.5, tail: 0.35, sweep: 0.3, morph: 3, revealS: mode.revealS },
    glow: { amount: 1, headroom: mode.headroom, color: { dark: [1, 1, 1], light: [1, 1, 1] } },
    touch: { stir: 1, ripple: 1, slowPxS: 60, fastPxS: 800 },
    composition: { card: { centerY: 0.45, calmX: mode.calmX, calmY: mode.calmY, left: mode.quiet } },
    grid: { cellCss: 6.5, minCols: 24, minRows: 8, maxDevicePixels: 21000000 },
    power: { frameMs: 40, rippleFrameMs: 10, backoffFrameMs: 83, budgetS: 180, settleS: 8, resumeS: 3, retryS: 60, retryMaxS: 480, resizeSettleMs: 150, linkDeadlineMs: 20000 },
  };
  const fontFamily = 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace';
  const alphabet = ' !"#$%&\'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~·';
  const looks = {
    mixed: 'ab0cAde1fEgh2iGjk3lHmn4oKpq5rMst6uRvw7xSyz8nT9eW',
    lettered: 'abcd3efgRhijk7lmnAopqr0stuEvwxy5zaeKiou2gcS9',
    figured: '0a1b2C3d4e5F6g7h8i9J0k1m2N3p4q5R6s7t8U9v0w1X2y3z',
  };
  const interactive = [
    'a,button,input,textarea,select,label,summary',
    '[contenteditable]:not([contenteditable="false"])',
    '[draggable="true"]', '[tabindex]:not([tabindex="-1"])',
    ...'button link textbox combobox listbox option menu menuitem tab switch checkbox radio slider dialog'.split(' ').map(role => `[role="${role}"]`),
  ].join(',');
  const recentLooks = [];

  function createShaders(config) {
    const glslNumber = (value) => Number.isInteger(value) ? `${value}.0` : `${value}`;
    const precision = `#version 300 es
  precision highp float;
  precision highp int;
  `;

    // Integer hashing keeps a visit's field and character choices deterministic.
    const random = `
  uint hash32(uint value) {
    uint state = value * 747796405u + 2891336453u;
    uint shuffled = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
    return (shuffled >> 22u) ^ shuffled;
  }
  float random01(uint bits) {
    return float(bits >> 8u) * (1.0 / 16777216.0);
  }
  `;

    const valueNoise = `
  float signedValue(uint key) {
    return 2.0 * random01(hash32(key)) - 1.0;
  }
  float valueNoise(vec3 position, uint channel) {
    vec3 cell = floor(position);
    vec3 offset = position - cell;
    ivec3 index = ivec3(cell);
    vec3 blend = offset * offset * offset * (offset * (offset * 6.0 - 15.0) + 10.0);
    uint left = uint(index.x);
    uint right = uint(index.x + 1);
    uint bottom = uint(index.y);
    uint top = uint(index.y + 1);
    uint back = hash32(uint(index.z) ^ u_seed ^ channel);
    uint front = hash32(uint(index.z + 1) ^ u_seed ^ channel);
    uint bottomBack = hash32(bottom ^ back);
    uint topBack = hash32(top ^ back);
    uint bottomFront = hash32(bottom ^ front);
    uint topFront = hash32(top ^ front);
    float backPlane = mix(
      mix(signedValue(left ^ bottomBack), signedValue(right ^ bottomBack), blend.x),
      mix(signedValue(left ^ topBack), signedValue(right ^ topBack), blend.x),
      blend.y
    );
    float frontPlane = mix(
      mix(signedValue(left ^ bottomFront), signedValue(right ^ bottomFront), blend.x),
      mix(signedValue(left ^ topFront), signedValue(right ^ topFront), blend.x),
      blend.y
    );
    return mix(backPlane, frontPlane, blend.z);
  }
  `;

    const gradientNoise = `
  vec3 latticeGradient(uint key) {
    uint bits = hash32(key);
    return vec3(
      float(bits & 1023u),
      float((bits >> 10u) & 1023u),
      float((bits >> 20u) & 1023u)
    ) * (2.0 / 1023.0) - 1.0;
  }
  float gradientNoise(vec3 position, uint channel) {
    vec3 cell = floor(position);
    vec3 offset = position - cell;
    ivec3 index = ivec3(cell);
    vec3 blend = offset * offset * offset * (offset * (offset * 6.0 - 15.0) + 10.0);
    uint left = uint(index.x);
    uint right = uint(index.x + 1);
    uint bottom = uint(index.y);
    uint top = uint(index.y + 1);
    uint back = hash32(uint(index.z) ^ u_seed ^ channel);
    uint front = hash32(uint(index.z + 1) ^ u_seed ^ channel);
    uint bottomBack = hash32(bottom ^ back);
    uint topBack = hash32(top ^ back);
    uint bottomFront = hash32(bottom ^ front);
    uint topFront = hash32(top ^ front);
    float backPlane = mix(
      mix(
        dot(latticeGradient(left ^ bottomBack), offset),
        dot(latticeGradient(right ^ bottomBack), offset - vec3(1.0, 0.0, 0.0)),
        blend.x
      ),
      mix(
        dot(latticeGradient(left ^ topBack), offset - vec3(0.0, 1.0, 0.0)),
        dot(latticeGradient(right ^ topBack), offset - vec3(1.0, 1.0, 0.0)),
        blend.x
      ),
      blend.y
    );
    float frontPlane = mix(
      mix(
        dot(latticeGradient(left ^ bottomFront), offset - vec3(0.0, 0.0, 1.0)),
        dot(latticeGradient(right ^ bottomFront), offset - vec3(1.0, 0.0, 1.0)),
        blend.x
      ),
      mix(
        dot(latticeGradient(left ^ topFront), offset - vec3(0.0, 1.0, 1.0)),
        dot(latticeGradient(right ^ topFront), offset - vec3(1.0)),
        blend.x
      ),
      blend.y
    );
    return 1.5 * mix(backPlane, frontPlane, blend.z);
  }
  `;

    const interactionShader = variant === 'wind' ? `
  uniform float u_now;
  uniform int u_tapCount;
  uniform vec4 u_taps[6];

  // xy displaces the field, z raises it, w measures disturbance. Glow is separate.
  vec4 tapAt(vec2 position, out vec2 glow) {
    vec4 disturbance = vec4(0.0);
    glow = vec2(0.0);
    for (int index = 0; index < 6; index++) {
      if (index >= u_tapCount) break;
      vec4 tap = u_taps[index];
      float elapsed = u_now - tap.z;
      vec2 delta = position - tap.xy;
      float distanceToTap = length(delta);
      vec2 outward = delta / max(distanceToTap, 1.0);
      float waveDistance = 620.0 * (1.0 - exp(-elapsed / 1.3)) - distanceToTap;
      float bandWidth = 85.0 + 60.0 * elapsed;
      float envelope = smoothstep(-16.0, 10.0, waveDistance)
        * exp(-waveDistance * waveDistance / (bandWidth * bandWidth));
      float amplitude = abs(tap.w) * exp(-elapsed / 1.5) * envelope;
      disturbance.xy += outward * (44.0 * amplitude);
      disturbance.z += 1.9 * amplitude
        * (0.25 + 0.75 * cos(waveDistance * (6.2831853 / 130.0)));
      disturbance.w += amplitude;

      float afterWave = smoothstep(0.0, 70.0, waveDistance)
        * exp(-max(waveDistance, 0.0) / 260.0);
      glow.x += abs(tap.w) * (
        exp(-elapsed / 1.0) * envelope + 0.7 * exp(-elapsed / 1.3) * afterWave
      );
      glow.y += abs(tap.w) * (1.0 - exp(-elapsed / 0.2))
        * exp(-elapsed / 1.2) * afterWave;
    }
    return disturbance;
  }
  ` : variant === 'capillary' ? `
  uniform float u_now;
  uniform int u_tapCount;
  uniform vec4 u_taps[6];

  float tissueValue(vec2 cell, uint channel) {
    return random01(hash32(uint(int(cell.x))
      ^ hash32(uint(int(cell.y)) ^ u_seed ^ channel))) * 2.0 - 1.0;
  }
  float tissueNoise(vec2 position, uint channel) {
    vec2 cell = floor(position);
    vec2 offset = fract(position);
    vec2 blend = offset * offset * (3.0 - 2.0 * offset);
    return mix(
      mix(tissueValue(cell, channel), tissueValue(cell + vec2(1.0, 0.0), channel), blend.x),
      mix(tissueValue(cell + vec2(0.0, 1.0), channel), tissueValue(cell + vec2(1.0), channel), blend.x),
      blend.y);
  }
  vec2 tissueCoordinates(vec2 position) {
    vec2 drift = position + vec2(-5.0, 2.0) * u_time;
    vec2 broad = vec2(
      tissueNoise(drift / 310.0 + vec2(u_time * 0.018, 0.0), 0xc1u),
      tissueNoise(drift / 290.0 + vec2(13.7, u_time * -0.014), 0xc2u));
    vec2 folded = drift + broad * 160.0;
    return folded + 35.0 * vec2(
      tissueNoise(folded / 95.0, 0xc3u),
      tissueNoise(folded / 110.0 + 5.3, 0xc4u));
  }

  vec4 tapAt(vec2 position, out vec2 glow) {
    vec4 disturbance = vec4(0.0);
    glow = vec2(0.0);
    if (u_tapCount == 0) return disturbance;
    vec2 materialPosition = tissueCoordinates(position);
    float permeability = 0.8 + 0.25 * tissueNoise(materialPosition / 140.0, 0xc5u);
    for (int index = 0; index < 6; index++) {
      if (index >= u_tapCount) break;
      vec4 tap = u_taps[index];
      float elapsed = max(0.0, u_now - tap.z);
      vec2 delta = materialPosition - tissueCoordinates(tap.xy);
      float distanceInMaterial = length(delta * vec2(0.82, 1.0));
      float arrival = distanceInMaterial / (160.0 * permeability);
      float age = elapsed - arrival;
      float absorbed = smoothstep(-0.25, 0.35, age)
        * exp(-max(age, 0.0) / 1.1) * exp(-elapsed / 2.6)
        * (1.0 - smoothstep(2.6, 3.6, elapsed));
      float pressure = abs(tap.w) * absorbed;
      disturbance.xy += delta / max(length(delta), 1.0) * 7.0 * pressure;
      disturbance.z += pressure * 0.95;
      disturbance.w += pressure;
      glow += pressure * vec2(1.2, 0.55);
    }
    return disturbance;
  }
  ` : `
  uniform float u_now;
  uniform int u_tapCount;
  uniform vec4 u_taps[6];

  vec4 tapAt(vec2 position, out vec2 glow) {
    vec4 disturbance = vec4(0.0);
    glow = vec2(0.0);
    if (u_tapCount == 0) return disturbance;
    vec2 driftPosition = position - vec2(52.0, 6.0) * u_now;
    vec2 bend = vec2(
      valueNoise(vec3(driftPosition / 205.0, u_time * 0.045), 0x101u),
      valueNoise(vec3(driftPosition / 165.0 + 17.7, u_time * 0.037 + 5.0), 0x102u)
    );
    float torn = valueNoise(vec3(driftPosition / 87.0, u_time * 0.065 + 3.0), 0x103u);
    float continuity = smoothstep(-0.48, 0.44, torn + 0.18 * bend.x);
    for (int index = 0; index < 6; index++) {
      if (index >= u_tapCount) break;
      vec4 tap = u_taps[index];
      float age = max(0.0, u_now - tap.z);
      vec2 offset = position - tap.xy - vec2(58.0, 7.0) * age;
      vec2 folded = offset + vec2(125.0, 88.0) * bend;
      vec2 stretched = folded / vec2(2.7, 1.0);
      float radius = length(stretched);
      vec2 outward = stretched / max(radius, 1.0);
      float reach = 470.0 * (1.0 - exp(-age / 1.18));
      float behind = reach - radius + 70.0 * bend.x + 34.0 * torn;
      float width = 56.0 + 42.0 * age;
      float front = smoothstep(-20.0, 12.0, behind)
        * exp(-behind * behind / (width * width));
      float life = tap.w * exp(-age / 1.45)
        * (1.0 - smoothstep(2.7, 3.6, age));
      float strength = life * front * continuity;
      disturbance.xy += (vec2(outward.x * 20.0, outward.y * 72.0)
        + vec2(46.0, 10.0) + 27.0 * vec2(-bend.y, bend.x)) * strength;
      disturbance.z += 0.8 * strength;
      disturbance.w += strength;
      float tail = smoothstep(0.0, 55.0, behind)
        * exp(-max(behind, 0.0) / 230.0) * continuity;
      glow.x += tap.w * (exp(-age / 1.05) * front * continuity
        + 0.5 * exp(-age / 1.35) * tail)
        * (1.0 - smoothstep(2.7, 3.6, age));
      glow.y += tap.w * (1.0 - exp(-age / 0.24))
        * exp(-age / 1.3) * tail * (1.0 - smoothstep(2.7, 3.6, age));
    }
    return disturbance;
  }
  `;

    const pointerTrail = `
  uniform int u_wakeCount;
  uniform vec4 u_wakes[48];
  uniform vec4 u_ways[48];

  float trailAt(vec2 position) {
    float accumulated = 0.0;
    for (int index = 0; index < 48; index++) {
      if (index >= u_wakeCount) break;
      vec4 segment = u_wakes[index];
      vec3 path = u_ways[index].xyz;
      vec2 offset = position - segment.xy;
      offset -= path.xy * clamp(dot(offset, path.xy), -path.z, path.z);
      accumulated += segment.z * exp(-dot(offset, offset) * segment.w);
    }
    return 1.0 - exp(-1.5 * accumulated);
  }
  `;

    const fieldVertex = `${precision}
  uniform uint u_seed;
  uniform float u_time;
  uniform vec4 u_wind;
  uniform vec2 u_canvasCss;
  out vec4 v_air;
  ${random}
  ${valueNoise}
  void main() {
    vec2 point = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
    gl_Position = vec4(point * 2.0 - 1.0, 0.0, 1.0);
    vec2 direction = vec2(cos(u_wind.x), sin(u_wind.x));
    float travel = u_wind.y * (
      u_time + valueNoise(vec3(u_time * 0.09, 3.7, 0.0), 0x58u)
    );
    float swellSpan = 0.58 * (
      abs(direction.x) * u_canvasCss.x + abs(direction.y) * u_canvasCss.y
    );
    v_air = vec4(direction, travel, swellSpan);
  }
  `;

    const card = config.composition.card;
    const fieldFragment = variant === 'wind' ? `${precision}
  uniform uint u_seed;
  uniform vec2 u_sampleCss, u_originCss, u_paneCss;
  uniform float u_time, u_reveal;
  uniform vec4 u_wind, u_gust, u_shape;
  uniform float u_tail, u_sweep, u_morph;
  in vec4 v_air;
  out vec4 o;

  const float TAU = 6.2831853;
  const vec2 QUIET_RADIUS = vec2(${glslNumber(card.calmX)}, ${glslNumber(card.calmY)});
  const float QUIET_STRENGTH = ${glslNumber(card.left)};
  const float QUIET_CENTER_Y = ${glslNumber(card.centerY)};
  ${random}
  ${valueNoise}
  ${gradientNoise}
  ${interactionShader}
  ${pointerTrail}

  float gustAt(vec2 position, float travel) {
    float octaveGain = mix(0.38, 0.62, u_shape.x);
    float sum = 0.0;
    float amplitude = 1.0;
    float squaredAmplitude = 0.0;
    vec2 wavelength = vec2(0.85, 0.75) * u_wind.zw;
    for (int octave = 0; octave < 4; octave++) {
      float index = float(octave);
      vec3 samplePosition = vec3(
        (position.x - travel * (1.0 + 0.1 * index)) / wavelength.x,
        position.y / wavelength.y,
        u_morph * u_time * (0.03 + 0.018 * index) + 11.0 * index
      );
      sum += amplitude * gradientNoise(samplePosition, 0x60u + uint(octave));
      squaredAmplitude += amplitude * amplitude;
      amplitude *= octaveGain;
      wavelength *= vec2(0.5, 0.58);
    }
    float filament = 1.0 - abs(gradientNoise(vec3(
      (position.x - 1.15 * travel) / (0.7 * u_wind.z),
      position.y / (0.95 * u_wind.w),
      u_morph * u_time * 0.05 + 2.0
    ), 0x66u));
    float phaseDrift = valueNoise(vec3(
      u_time * 0.045, position.y / (2.5 * u_wind.w), 7.0
    ), 0x67u);
    float swell = cos(
      (position.x - travel + 0.5 * v_air.w * phaseDrift) * (TAU / v_air.w)
    );
    return sum * inversesqrt(squaredAmplitude)
      + u_shape.w * 0.5 * (filament * filament * filament - 0.35)
      + u_sweep * swell;
  }

  void main() {
    vec2 position = u_originCss + gl_FragCoord.xy * u_sampleCss;
    vec2 direction = v_air.xy;
    vec2 perpendicular = vec2(-direction.y, direction.x);
    vec4 disturbance = vec4(0.0);
    float warmth = 0.0;
    if (u_tapCount + u_wakeCount > 0) {
      // Uneven sampling keeps the interaction boundary embedded in the field.
      vec2 interactionPosition = position + 24.0 * vec2(
        valueNoise(vec3(position / 95.0, u_now * 0.12), 0x71u),
        valueNoise(vec3(position / 95.0 + 9.1, u_now * 0.12 + 4.0), 0x72u)
      );
      vec2 unusedGlow;
      disturbance = tapAt(interactionPosition, unusedGlow);
      warmth = trailAt(interactionPosition);
      disturbance.zw += vec2(0.25, 0.05) * warmth;
    }

    vec2 displaced = position - disturbance.xy;
    vec2 bend = vec2(
      valueNoise(vec3(displaced / u_gust.y, u_time * 0.04), 0x51u),
      valueNoise(vec3(displaced / u_gust.y + 17.3, u_time * 0.04 + 5.0), 0x52u)
    );
    vec2 bentPosition = displaced + u_gust.x * bend;
    vec2 windPosition = vec2(dot(bentPosition, direction), dot(bentPosition, perpendicular));
    float travel = v_air.z;

    vec2 drifting = vec2(windPosition.x - 0.85 * travel, windPosition.y);
    float largeScale = 1.15 * u_wind.w;
    float smallScale = 0.38 * u_wind.w;
    vec2 largeCurl = vec2(
      gradientNoise(vec3(drifting / largeScale, u_morph * u_time * 0.04), 0x59u),
      gradientNoise(vec3(drifting / largeScale + 31.7, u_morph * u_time * 0.04 + 3.0), 0x5au)
    );
    vec2 folded = drifting + u_shape.z * 0.9 * u_wind.w * largeCurl;
    vec2 smallCurl = vec2(
      gradientNoise(vec3(folded / smallScale, u_morph * u_time * 0.06), 0x5bu),
      gradientNoise(vec3(folded / smallScale + 13.1, u_morph * u_time * 0.06 + 7.0), 0x5cu)
    );
    vec2 creases = (folded + 0.3 * u_wind.w * smallCurl) / 24.0;
    vec2 fineCurl = vec2(
      gradientNoise(vec3(creases, u_time * 0.07), 0x5du),
      gradientNoise(vec3(creases + 5.3, u_time * 0.07 + 1.0), 0x5eu)
    );
    vec2 curlOffset = u_shape.z * (1.0 + 0.9 * min(disturbance.w, 1.5)) * (
      u_wind.w * (0.9 * largeCurl + 0.3 * smallCurl) + u_shape.x * 30.0 * fineCurl
    );
    vec2 curledPosition = windPosition + curlOffset;
    vec2 flowDirection = normalize(
      direction + 0.6 * bend + disturbance.xy / 14.0 + u_shape.z * (
        (0.45 * largeCurl.x + 0.25 * smallCurl.x) * direction
        + (0.45 * largeCurl.y + 0.25 * smallCurl.y) * perpendicular
      )
    );

    float ambient = gustAt(curledPosition, travel);
    float field = ambient + disturbance.z;
    float threshold = mix(0.02, 0.82, u_gust.z);
    float transitionWidth = mix(0.26, 0.03, u_shape.y);
    bool visibleGust = field > threshold - transitionWidth - 0.55 * u_tail;
    float intensity = 0.0;
    float streak = 0.0;
    if (visibleGust || warmth > 0.0) {
      float streakNoise = valueNoise(vec3(
        (curledPosition.x - travel * 1.6) / 140.0,
        curledPosition.y / 30.0,
        u_time * 0.16
      ), 0x57u);
      streak = 1.0 - smoothstep(0.0, 0.5, abs(streakNoise));
    }
    if (visibleGust) {
      float nextSample = gustAt(curledPosition + vec2(56.0, 0.0), travel);
      float trailingEdge = smoothstep(-0.05, 0.07, nextSample - ambient);
      float coverage = smoothstep(
        threshold - transitionWidth - 0.55 * u_tail * trailingEdge,
        threshold + transitionWidth,
        field
      );
      float broadLight = coverage * coverage
        * mix(0.45, 1.0, clamp((field - threshold) / 0.45, 0.0, 1.0))
        * (0.82 + 0.18 * smallCurl.y);
      intensity = broadLight * mix(1.0, 0.25 + 0.95 * streak, u_gust.w);
    }
    if (warmth > 0.0) {
      float grain = 0.55 * smallCurl.y + 0.45 * fineCurl.x + 0.3 * (streak - 0.4);
      intensity = 1.0 - (1.0 - intensity)
        * (1.0 - 0.85 * warmth * smoothstep(-0.5, 0.25, grain));
    }

    vec2 quietPosition = (position - vec2(0.5 * u_paneCss.x, QUIET_CENTER_Y * u_paneCss.y))
      / QUIET_RADIUS;
    float quietMask = 1.0 - (1.0 - QUIET_STRENGTH)
      * exp(-0.9 * dot(quietPosition, quietPosition));
    float reveal = max(u_reveal, min(1.0, 2.0 * disturbance.w + warmth));
    o = vec4(intensity * quietMask * reveal, flowDirection * 0.5 + 0.5, quietMask * reveal);
  }
  ` : variant === 'capillary' ? `${precision}
  uniform uint u_seed;
  uniform vec2 u_sampleCss, u_originCss, u_paneCss;
  uniform float u_time, u_reveal;
  out vec4 o;
  ${random}
  ${interactionShader}
  ${pointerTrail}

  void main() {
    vec2 position = u_originCss + gl_FragCoord.xy * u_sampleCss;
    vec2 glow;
    vec4 disturbance = tapAt(position, glow);
    float warmth = trailAt(position);
    vec2 tissue = tissueCoordinates(position - disturbance.xy);
    float trunk = tissueNoise(tissue / vec2(230.0, 185.0), 0xd1u);
    float twig = tissueNoise(tissue / vec2(125.0, 190.0) + 8.7, 0xd2u);
    float branching = tissueNoise(tissue / 390.0 + u_time * 0.01, 0xd3u);
    float trunkLight = exp(-trunk * trunk / 0.0065);
    float twigLight = exp(-twig * twig / 0.0045)
      * smoothstep(-0.4, 0.5, branching);
    float material = 1.0 - (1.0 - trunkLight) * (1.0 - twigLight * 0.7);
    float breathing = 0.6 + 0.4 * tissueNoise(tissue / 260.0
      + vec2(u_time * 0.035, -u_time * 0.025), 0xd4u);
    float ambient = material * (0.28 + 0.52 * breathing);
    // Input changes the light in the veins; it cannot illuminate the empty gaps.
    float intensity = min(1.0, ambient + material * (disturbance.z + warmth * 0.5));
    vec2 quietPosition = (position - vec2(u_paneCss.x * 0.5, u_paneCss.y * 0.45))
      / vec2(230.0, 80.0);
    float quietMask = 1.0 - 0.3 * exp(-0.9 * dot(quietPosition, quietPosition));
    float reveal = max(u_reveal, min(1.0, disturbance.w + warmth));
    vec2 direction = normalize(vec2(0.8 + 0.3 * trunk, 0.5 + 0.3 * twig));
    o = vec4(intensity * quietMask * reveal,
      direction * 0.5 + 0.5, quietMask * reveal);
  }
  ` : `${precision}
  uniform uint u_seed;
  uniform vec2 u_sampleCss, u_originCss, u_paneCss;
  uniform float u_time, u_reveal;
  uniform vec4 u_wind, u_gust, u_shape;
  uniform float u_tail, u_sweep, u_morph;
  in vec4 v_air;
  out vec4 o;

  const float TAU = 6.2831853;
  const vec2 QUIET_RADIUS = vec2(${glslNumber(card.calmX)}, ${glslNumber(card.calmY)});
  const float QUIET_STRENGTH = ${glslNumber(card.left)};
  const float QUIET_CENTER_Y = ${glslNumber(card.centerY)};
  ${random}
  ${valueNoise}
  ${gradientNoise}
  ${interactionShader}
  ${pointerTrail}

  float streamAt(vec2 position, float offset, uint channel) {
    float body = gradientNoise(vec3(position / vec2(340.0, 145.0),
      u_time * 0.058 + offset), channel);
    float fold = gradientNoise(vec3(position / vec2(145.0, 66.0) + 9.7,
      u_time * 0.09 + offset + 5.0), channel + 1u);
    float thread = gradientNoise(vec3(position / vec2(57.0, 31.0) + 21.3,
      u_time * 0.14 + offset + 9.0), channel + 2u);
    return smoothstep(-0.27, 0.32, body + 0.36 * fold + 0.17 * thread)
      * (0.73 + 0.27 * thread);
  }

  void main() {
    vec2 position = u_originCss + gl_FragCoord.xy * u_sampleCss;
    vec2 unusedGlow;
    vec4 surge = tapAt(position, unusedGlow);
    float warmth = u_wakeCount > 0 ? trailAt(position) : 0.0;
    vec2 displaced = position - surge.xy;
    vec2 broadCurl = vec2(
      gradientNoise(vec3(displaced / vec2(410.0, 270.0), u_time * 0.041), 0x111u),
      gradientNoise(vec3(displaced / vec2(410.0, 270.0) + 31.7, u_time * 0.047 + 3.0), 0x112u)
    );
    vec2 folded = displaced + 86.0 * broadCurl;
    vec2 smallCurl = vec2(
      gradientNoise(vec3(folded / 112.0, u_time * 0.083), 0x113u),
      gradientNoise(vec3(folded / 112.0 + 13.1, u_time * 0.076 + 7.0), 0x114u)
    );
    vec2 flowing = folded + (34.0 + 24.0 * warmth) * smallCurl;
    float confluence = smoothstep(0.12 * u_paneCss.x, 0.88 * u_paneCss.x, flowing.x);
    float broadBend = valueNoise(vec3(flowing.x / 520.0, u_time * 0.028, 4.3), 0x115u);
    float smallBend = valueNoise(vec3(flowing.x / 210.0 + 11.0, u_time * 0.041, 8.1), 0x116u);
    float boundary = u_paneCss.y * (0.47 + 0.12 * broadBend + 0.045 * smallBend);
    float upperOffset = mix(0.23, 0.03, confluence) * u_paneCss.y;
    float lowerOffset = mix(0.29, 0.015, confluence) * u_paneCss.y;
    float upperWidth = max(80.0, 0.18 * u_paneCss.y) * (1.0 + 0.18 * confluence);
    float lowerWidth = max(60.0, 0.12 * u_paneCss.y) * (1.0 + 0.25 * confluence);
    float upperDistance = (flowing.y - boundary + upperOffset) / upperWidth;
    float lowerDistance = (flowing.y - boundary - lowerOffset) / lowerWidth;
    vec2 upperPosition = vec2(flowing.x - 39.0 * u_time,
      flowing.y - boundary + upperOffset - 13.0 * u_time * (1.0 - confluence));
    vec2 lowerPosition = vec2(flowing.x - 67.0 * u_time,
      flowing.y - boundary - lowerOffset + 9.0 * u_time * (1.0 - confluence));
    float upper = 0.94 * exp(-upperDistance * upperDistance)
      * streamAt(upperPosition, 0.0, 0x117u);
    float lower = 0.77 * exp(-lowerDistance * lowerDistance)
      * streamAt(lowerPosition, 14.0, 0x11bu);
    float material = 1.0 - (1.0 - upper) * (1.0 - lower);
    float intensity = min(1.0, material * (1.0 + surge.z + 0.35 * warmth));
    intensity = intensity < 0.008 ? 0.0 : intensity;
    float lowerShare = lower / max(upper + lower, 0.001);
    vec2 direction = normalize(vec2(1.0, mix(0.24, -0.18, lowerShare) * (1.0 - confluence))
      + 0.22 * smallCurl);
    vec2 quietPosition = (position - vec2(0.5 * u_paneCss.x, QUIET_CENTER_Y * u_paneCss.y))
      / QUIET_RADIUS;
    float quietMask = 1.0 - (1.0 - QUIET_STRENGTH)
      * exp(-0.9 * dot(quietPosition, quietPosition));
    float reveal = max(u_reveal, min(1.0, 2.0 * surge.w + warmth));
    o = vec4(intensity * quietMask * reveal, direction * 0.5 + 0.5, quietMask * reveal);
  }
  `;

    const skipInvisible = config.surface.skipUnseen && config.strength.rest <= 0.030000000000000002;
    const glyphGlow = variant === 'wind' ? `      glow *= 0.65 + 0.35 * random01(hash32(timing ^ 0x51u));
  ` : variant === 'capillary' ? `      ivec2 materialCell = clamp(cell * FIELD_SAMPLES + ivec2(0, 1), ivec2(0), u_grid * FIELD_SAMPLES - 1);
      float materialLight = texelFetch(u_wind, materialCell, 0).r;
      glow *= smoothstep(0.025, 0.22, materialLight)
        * (0.65 + 0.35 * random01(hash32(timing ^ 0x51u)));
  ` : `      ivec2 materialCell = clamp(cell * FIELD_SAMPLES + ivec2(0, 1),
        ivec2(0), u_grid * FIELD_SAMPLES - 1);
      float material = texelFetch(u_wind, materialCell, 0).r;
      glow *= smoothstep(0.025, 0.22, material)
        * (0.65 + 0.35 * random01(hash32(timing ^ 0x51u)));
  `;
    const glyphVertex = `${precision}
  uniform highp usampler2D u_boxes;
  uniform highp sampler2D u_sequence, u_wind;
  uniform ivec2 u_grid, u_cell, u_buffer;
  uniform uint u_seed;
  uniform float u_time, u_fill, u_flick;
  uniform int u_count;
  uniform vec4 u_cellCss;
  out vec2 v_shift;
  out vec4 v_box;
  out vec2 v_glow;

  const ivec2 QUAD[6] = ivec2[6](
    ivec2(0, 0), ivec2(1, 0), ivec2(0, 1),
    ivec2(0, 1), ivec2(1, 0), ivec2(1, 1)
  );
  const ivec2 FIELD_SAMPLES = ivec2(1, 2);
  ${random}
  ${variant === 'estuary' ? valueNoise : ''}
  ${interactionShader}

  void hideGlyph() {
    gl_Position = vec4(2.0, 2.0, 0.0, 1.0);
    v_shift = vec2(0.0);
    v_box = vec4(0.0);
    v_glow = vec2(0.0);
  }

  void main() {
    int glyphIndex = gl_VertexID / 6;
    ivec2 cell = ivec2(glyphIndex % u_grid.x, glyphIndex / u_grid.x);
    uint identity = hash32((uint(cell.x) * 0x9E3779B9u) ^ hash32(uint(cell.y) ^ u_seed));
    if (random01(identity) >= u_fill) {
      hideGlyph();
      return;
    }

    uint timing = hash32(identity);
    int sequenceStep = int(floor(
      u_time * u_flick * (0.6 + 0.8 * random01(timing)) + random01(hash32(timing))
    ));
    vec2 glow = vec2(0.0);
    if (u_tapCount > 0) {
      vec4 disturbance = tapAt(u_cellCss.xy + vec2(cell) * u_cellCss.zw, glow);
      sequenceStep += int(floor(6.0 * disturbance.w + random01(hash32(timing ^ 0x33u))));
      ${glyphGlow}
    }

    if (${skipInvisible ? "true" : "false"} && glow.x < 0.04 && glow.y < 0.015) {
      ivec2 firstSample = cell * FIELD_SAMPLES;
      ivec2 lastSample = u_grid * FIELD_SAMPLES - 1;
      float strongest = 0.0;
      for (int row = -1; row <= FIELD_SAMPLES.y; row++) {
        for (int column = -1; column <= FIELD_SAMPLES.x; column++) {
          ivec2 sampleAt = clamp(firstSample + ivec2(column, row), ivec2(0), lastSample);
          strongest = max(strongest, texelFetch(u_wind, sampleAt, 0).r);
        }
      }
      if (strongest == 0.0) {
        hideGlyph();
        return;
      }
    }

    int sequenceIndex = (int(identity >> 8u) + sequenceStep) % u_count;
    int character = int(texelFetch(u_sequence, ivec2(sequenceIndex, 0), 0).r * 255.0 + 0.5);
    uvec4 bounds = texelFetch(u_boxes, ivec2(character, 0), 0);
    ivec2 cellOrigin = cell * u_cell;
    ivec2 pixel = cellOrigin + ivec2(bounds.xy)
      + QUAD[gl_VertexID - glyphIndex * 6] * ivec2(bounds.zw);
    ivec2 atlasOrigin = ivec2(character & 15, character >> 4) * u_cell;
    v_shift = vec2(atlasOrigin - cellOrigin);
    v_box = vec4(atlasOrigin, atlasOrigin + u_cell - 1);
    v_glow = glow;
    vec2 clipPosition = vec2(pixel) / vec2(u_buffer) * 2.0 - 1.0;
    gl_Position = vec4(clipPosition.x, -clipPosition.y, 0.0, 1.0);
  }
  `;

    const glyphLight = variant === 'wind' ? `    float tint = smoothstep(0.04, 0.3, u_glowAmount * v_glow.x);
    float brightness = min(1.0, illumination) * mix(u_inkAlpha, GLOW_HEADROOM, tint);
    float afterglow = u_glowAmount * 0.3 * v_glow.y * field.a;
  ` : variant === 'capillary' ? `    float material = smoothstep(0.025, 0.22, field.r);
    float tint = smoothstep(0.04, 0.3, u_glowAmount * v_glow.x * material);
    float brightness = min(1.0, illumination) * mix(u_inkAlpha, GLOW_HEADROOM, tint);
    float afterglow = u_glowAmount * 0.3 * v_glow.y * field.r * material;
  ` : `    float materialGlow = smoothstep(0.025, 0.22, field.r);
    float tint = smoothstep(0.04, 0.3, u_glowAmount * v_glow.x) * materialGlow;
    float brightness = min(1.0, illumination) * mix(u_inkAlpha, GLOW_HEADROOM, tint);
    float afterglow = u_glowAmount * 0.3 * v_glow.y * field.a * materialGlow;
  `;
    const glyphFragment = `${precision}
  in vec2 v_shift;
  in vec4 v_box;
  in vec2 v_glow;
  uniform highp sampler2D u_atlas, u_wind;
  uniform vec3 u_color, u_glowColor;
  uniform ivec2 u_buffer;
  uniform float u_friction, u_glowAmount, u_inkAlpha;
  out vec4 o;

  const float REST_LIGHT = ${glslNumber(config.strength.rest)};
  const float GLOW_HEADROOM = ${glslNumber(config.glow.headroom)};
  ivec4 glyphBounds;

  float glyphCoverage(ivec2 pixel) {
    return texelFetch(u_atlas, clamp(pixel, glyphBounds.xy, glyphBounds.zw), 0).r;
  }

  void main() {
    glyphBounds = ivec4(floor(v_box + 0.5));
    ivec2 pixel = ivec2(int(gl_FragCoord.x), u_buffer.y - 1 - int(gl_FragCoord.y));
    ivec2 atlasPixel = pixel + ivec2(floor(v_shift + 0.5));
    float coverage = glyphCoverage(atlasPixel);
    if (coverage <= 0.0) {
      o = vec4(0.0);
      return;
    }

    vec4 field = texture(u_wind, (vec2(pixel) + 0.5) / vec2(u_buffer));
    vec2 direction = field.gb * 2.0 - 1.0;
    vec2 strokeGradient = vec2(
      glyphCoverage(atlasPixel + ivec2(1, 0)) - glyphCoverage(atlasPixel - ivec2(1, 0)),
      glyphCoverage(atlasPixel + ivec2(0, 1)) - glyphCoverage(atlasPixel - ivec2(0, 1))
    );
    float slope = length(strokeGradient);
    float facing = slope > 0.02 ? max(0.0, dot(strokeGradient / slope, direction)) : 0.35;
    float edgeLight = mix(1.0, 0.45 + 1.1 * facing, u_friction);
    float illumination = min(1.0, field.r * edgeLight) + REST_LIGHT * field.a;
    ${glyphLight}
    float alpha = coverage * min(1.0, (brightness + afterglow) / GLOW_HEADROOM);
    vec3 color = (
      mix(u_color, u_glowColor, tint) * brightness + u_glowColor * afterglow
    ) / (brightness + afterglow + 0.0001);
    o = vec4(color * alpha, alpha);
  }
  `;

    return { fieldVertex, fieldFragment, glyphVertex, glyphFragment };
  }

  const roots = [...scope.querySelectorAll('[data-ascii-wind]')];
  if (scope.matches?.('[data-ascii-wind]')) roots.unshift(scope);
  const disposers = roots.map(mount);
  return () => disposers.forEach(dispose => dispose());

  function smooth(value) {
    const limited = Math.min(1, Math.max(0, value));
    return limited * limited * (3 - 2 * limited);
  }

  function hash(value) {
    let bits = value >>> 0;
    bits = Math.imul(bits ^ bits >>> 16, 569420461);
    bits = Math.imul(bits ^ bits >>> 15, 1935289751);
    return (bits ^ bits >>> 15) >>> 0;
  }

  function random(seed, label) {
    let state = hash(seed);
    for (const character of label) state = hash(state ^ character.charCodeAt(0));
    return () => {
      state = state + 2654435769 >>> 0;
      return hash(state) / 4294967296;
    };
  }

  function makeProfile() {
    const seed = window.crypto.getRandomValues(new Uint32Array(1))[0];
    const names = Object.keys(looks);
    const fresh = names.filter(name => !recentLooks.includes(name));
    const choices = fresh.length ? fresh : names.filter(name => name !== recentLooks[0]);
    const key = choices[Math.floor(random(seed, 'look')() * choices.length)] || names[0];
    recentLooks.unshift(key);
    recentLooks.length = Math.min(3, recentLooks.length);
    const sample = random(seed, 'wind');
    const range = (low, high) => low + (high - low) * sample();
    const turn = sample();
    const angle = Math.PI / 10 + (Math.PI / 4.3 - Math.PI / 10) * (turn * 2 % 1);
    return { key, seed, heading: turn < 0.5 ? angle : Math.PI - angle, speed: range(42, 64), gustLength: range(380, 560), gustWidth: range(120, 190), bend: range(60, 110), bendScale: range(300, 440) };
  }

  function createTouch() {
    let taps = [];
    let wakes = [];
    let pointer = null;
    let lastWake = null;
    let speed = 0;
    const result = { now: 0, tapCount: 0, taps: new Float32Array(24), wakeCount: 0, wakes: new Float32Array(192), ways: new Float32Array(192) };
    return {
      move(x, y, at) {
        if (!pointer || !lastWake || at - pointer.at > 0.25) {
          pointer = { x, y, at };
          lastWake = pointer;
          speed = 0;
          return;
        }
        const elapsed = Math.max(at - pointer.at, 1 / 240);
        const moved = Math.hypot(x - pointer.x, y - pointer.y);
        speed += (moved / elapsed - speed) * Math.min(1, elapsed / 0.08);
        pointer = { x, y, at };
        const distance = Math.hypot(x - lastWake.x, y - lastWake.y);
        if (distance < 18 || at - lastWake.at < 0.035) return;
        const force = config.touch.stir * smooth((speed - config.touch.slowPxS) / (config.touch.fastPxS - config.touch.slowPxS));
        const from = lastWake;
        lastWake = pointer;
        if (force < 0.04) return;
        wakes = [...wakes.slice(-47), { x: (x + from.x) / 2, y: (y + from.y) / 2, at, force: force * distance / (distance + 90), wayX: (x - from.x) / 2, wayY: (y - from.y) / 2 }];
      },
      tap(x, y, at) {
        const force = config.touch.ripple;
        taps = [...taps.slice(-5), { x, y, at, force }];
      },
      leave() { pointer = null; },
      busy(now) { return taps.some(tap => now - tap.at < 3.6) || wakes.some(wake => now - wake.at < 2.4); },
      rippling(now) { return taps.some(tap => now - tap.at < 3.6); },
      frame(now) {
        taps = taps.filter(tap => now - tap.at < 3.6);
        wakes = wakes.filter(wake => now - wake.at < 2.4);
        result.now = now;
        result.tapCount = taps.length;
        taps.forEach((tap, index) => result.taps.set([tap.x, tap.y, tap.at, tap.force], index * 4));
        const spare = 48 - wakes.length;
        let count = 0;
        wakes.forEach((wake, index) => {
          const age = Math.max(0, now - wake.at);
          const force = wake.force * Math.min(1, (index + 1 + spare) / 8) * (1 - Math.exp(-age / 0.05)) * Math.exp(-age / 0.65);
          if (force < 0.002) return;
          const reach = 50 + 40 * age;
          const length = Math.hypot(wake.wayX, wake.wayY);
          result.wakes.set([wake.x, wake.y, force, 1 / (reach * reach)], count * 4);
          result.ways.set([wake.wayX / (length || 1), wake.wayY / (length || 1), length, 0], count * 4);
          count += 1;
        });
        result.wakeCount = count;
        return result;
      },
    };
  }

  function createAtlas(cellWidth, cellHeight, scale, profile) {
    const canvas = document.createElement('canvas');
    canvas.width = cellWidth * 16;
    canvas.height = cellHeight * 6;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('Glyph canvas unavailable');
    const weight = scale >= 1.5 ? config.surface.weight : config.surface.weight + 100;
    context.font = `${weight} 100px ${fontFamily}`;
    const proportion = context.measureText('0').width / 100 || 0.6;
    const size = Math.min(Math.round(config.surface.glyphCss * scale), Math.floor((cellWidth - 2) / proportion));
    context.font = `${weight} ${size}px ${fontFamily}`;
    context.textAlign = 'left';
    context.textBaseline = 'alphabetic';
    context.fillStyle = 'white';
    const metrics = context.measureText('Mg|');
    const ascent = metrics.fontBoundingBoxAscent ?? metrics.actualBoundingBoxAscent;
    const descent = metrics.fontBoundingBoxDescent ?? metrics.actualBoundingBoxDescent;
    const baseline = Math.round((cellHeight - ascent - descent) / 2 + ascent);
    const letterWidth = context.measureText('0').width;
    const left = Math.floor((cellWidth - letterWidth) / 2);
    const missing = [...alphabet].map((letter, index) => {
      if (Math.abs(context.measureText(letter).width - letterWidth) > 0.5) return true;
      const x = index % 16 * cellWidth;
      const y = Math.floor(index / 16) * cellHeight;
      context.save();
      context.beginPath();
      context.rect(x, y, cellWidth, cellHeight);
      context.clip();
      context.fillText(letter, x + left, y + baseline);
      context.restore();
      return false;
    });
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    const coverage = new Uint8Array(canvas.width * canvas.height);
    for (let index = 0; index < coverage.length; index += 1) coverage[index] = pixels[index * 4 + 3];
    const boxes = new Uint8Array(alphabet.length * 4);
    for (let index = 0; index < alphabet.length; index += 1) {
      const originX = index % 16 * cellWidth;
      const originY = Math.floor(index / 16) * cellHeight;
      let minX = cellWidth, minY = cellHeight, maxX = -1, maxY = -1;
      for (let y = 0; y < cellHeight; y += 1) {
        for (let x = 0; x < cellWidth; x += 1) {
          if (coverage[(originY + y) * canvas.width + originX + x] < 8) continue;
          minX = Math.min(minX, x);
          minY = Math.min(minY, y);
          maxX = Math.max(maxX, x);
          maxY = Math.max(maxY, y);
        }
      }
      if (maxX >= 0) boxes.set([minX, minY, maxX - minX + 1, maxY - minY + 1], index * 4);
    }
    const sequence = [...looks[profile.key]].map(letter => alphabet.indexOf(letter)).filter(index => index > 0 && !missing[index]);
    return { coverage, boxes, sequence: Uint8Array.from(sequence.length ? sequence : [alphabet.indexOf('.')]) };
  }

  function mount(root) {
    root.__asciiWindCleanup?.();
    root.dataset.asciiWindVariant = variant;
    const controller = new window.AbortController();
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const contrast = window.matchMedia('(forced-colors: active), (prefers-contrast: more)');
    let disposed = false;
    let revision = 0;
    let stopAnimation = () => {};
    const destroy = () => {
      if (disposed) return;
      disposed = true;
      revision += 1;
      controller.abort();
      stopAnimation();
      if (root.__asciiWindCleanup === destroy) delete root.__asciiWindCleanup;
    };
    root.__asciiWindCleanup = destroy;
    const start = async () => {
      const current = ++revision;
      stopAnimation();
      stopAnimation = () => {};
      if (disposed || motion.matches || contrast.matches) return;
      const isCancelled = () => disposed || current !== revision;
      try {
        await document.fonts?.ready;
        if (isCancelled()) return;
        const animation = createAnimation(root, isCancelled);
        stopAnimation = animation.destroy;
        await animation.start();
      } catch {
        if (!isCancelled()) stopAnimation();
      }
    };
    motion.addEventListener('change', start, { signal: controller.signal });
    contrast.addEventListener('change', start, { signal: controller.signal });
    void start();
    return destroy;
  }

  function createAnimation(root, isCancelled) {
    const controller = new window.AbortController();
    const cleanups = [];
    const programs = [];
    const shaders = [];
    const textures = [];
    const canvas = document.createElement('canvas');
    canvas.setAttribute('aria-hidden', 'true');
    canvas.dataset.asciiWindCanvas = '';
    Object.assign(canvas.style, { position: 'absolute', display: 'block', pointerEvents: 'none', zIndex: '-1', opacity: '0' });
    let gl = null;
    let framebuffer = null;
    let fence = null;
    let stopped = false;
    let timer = 0;
    let frame = 0;
    let paletteFrame = 0;
    let resizeTimer = 0;
    let retryTimer = 0;
    let compileTimer = 0;
    let resolveCompileWait = null;
    let resolveFocusWait = null;
    let resizeObserver = null;
    let intersectionObserver = null;
    let mutationObserver = null;

    function destroy() {
      if (stopped) return;
      stopped = true;
      controller.abort();
      window.clearTimeout(timer);
      window.clearTimeout(resizeTimer);
      window.clearTimeout(retryTimer);
      window.clearTimeout(compileTimer);
      window.cancelAnimationFrame(frame);
      window.cancelAnimationFrame(paletteFrame);
      resolveCompileWait?.();
      resolveFocusWait?.();
      resizeObserver?.disconnect();
      intersectionObserver?.disconnect();
      mutationObserver?.disconnect();
      cleanups.reverse().forEach(cleanup => cleanup());
      canvas.remove();
      if (gl && !gl.isContextLost()) {
        if (fence) gl.deleteSync(fence);
        shaders.forEach(shader => gl.deleteShader(shader));
        programs.forEach(program => gl.deleteProgram(program));
        textures.forEach(texture => gl.deleteTexture(texture));
        if (framebuffer) gl.deleteFramebuffer(framebuffer);
        gl.getExtension('WEBGL_lose_context')?.loseContext();
      }
    }

    function cancelled() { return stopped || isCancelled(); }

    function listen(target, type, listener, options = {}) {
      target.addEventListener(type, listener, { ...options, signal: controller.signal });
    }

    function makeProgram(vertexSource, fragmentSource) {
      const program = gl.createProgram();
      if (!program) throw new Error('Program allocation failed');
      programs.push(program);
      for (const [type, source] of [[gl.VERTEX_SHADER, vertexSource], [gl.FRAGMENT_SHADER, fragmentSource]]) {
        const shader = gl.createShader(type);
        if (!shader) throw new Error('Shader allocation failed');
        shaders.push(shader);
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        gl.attachShader(program, shader);
      }
      gl.linkProgram(program);
      return program;
    }

    function makeTexture(unit, smooth = false) {
      const texture = gl.createTexture();
      if (!texture) throw new Error('Texture allocation failed');
      textures.push(texture);
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, smooth ? gl.LINEAR : gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, smooth ? gl.LINEAR : gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return texture;
    }

    function upload(unit, internalFormat, format, width, height, data) {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, width, height, 0, format, gl.UNSIGNED_BYTE, data);
      if (gl.getError() !== gl.NO_ERROR) throw new Error('Texture upload failed');
    }

    async function start() {
      if (document.hidden || !focusWindow.document.hasFocus()) {
        await new Promise(resolve => {
          resolveFocusWait = resolve;
          const focused = () => {
            if (document.hidden || !focusWindow.document.hasFocus()) return;
            document.removeEventListener('visibilitychange', focused);
            focusWindow.removeEventListener('focus', focused);
            resolveFocusWait = null;
            resolve();
          };
          listen(document, 'visibilitychange', focused);
          listen(focusWindow, 'focus', focused);
        });
      }
      if (cancelled()) return;
      gl = canvas.getContext('webgl2', { alpha: true, antialias: false, depth: false, stencil: false, premultipliedAlpha: true, preserveDrawingBuffer: false, powerPreference: 'low-power', failIfMajorPerformanceCaveat: true });
      if (!gl) { destroy(); return; }
      listen(canvas, 'webglcontextlost', destroy);
      const debug = gl.getExtension('WEBGL_debug_renderer_info');
      if (debug && /swiftshader|llvmpipe|softpipe|software|warp|basic render/i.test(String(gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)))) { destroy(); return; }
      const profile = makeProfile();
      const shaderSource = createShaders(config);
      const fieldProgram = makeProgram(shaderSource.fieldVertex, shaderSource.fieldFragment);
      const glyphProgram = makeProgram(shaderSource.glyphVertex, shaderSource.glyphFragment);
      const parallel = gl.getExtension('KHR_parallel_shader_compile');
      if (parallel) {
        const deadline = window.performance.now() + config.power.linkDeadlineMs;
        while (programs.some(program => gl.getProgramParameter(program, parallel.COMPLETION_STATUS_KHR) !== true)) {
          if (cancelled() || window.performance.now() > deadline) { destroy(); return; }
          await new Promise(resolve => {
            resolveCompileWait = resolve;
            compileTimer = window.setTimeout(() => { resolveCompileWait = null; resolve(); }, 50);
          });
        }
      }
      if (cancelled()) return;
      if (programs.some(program => !gl.getProgramParameter(program, gl.LINK_STATUS)) || shaders.some(shader => !gl.getShaderParameter(shader, gl.COMPILE_STATUS))) { destroy(); return; }
      shaders.splice(0).forEach(shader => gl.deleteShader(shader));
      const windTexture = makeTexture(0, true);
      makeTexture(1);
      makeTexture(2);
      makeTexture(3);
      framebuffer = gl.createFramebuffer();
      if (!framebuffer) { destroy(); return; }
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      const field = Object.fromEntries(['u_seed', 'u_tail', 'u_sweep', 'u_morph', 'u_wind', 'u_gust', 'u_shape', 'u_time', 'u_reveal', 'u_sampleCss', 'u_originCss', 'u_paneCss', 'u_canvasCss', 'u_now', 'u_tapCount', 'u_taps', 'u_wakeCount', 'u_wakes', 'u_ways'].map(name => [name, gl.getUniformLocation(fieldProgram, name)]));
      const glyph = Object.fromEntries(['u_wind', 'u_atlas', 'u_boxes', 'u_sequence', 'u_seed', 'u_fill', 'u_flick', 'u_friction', 'u_glowAmount', 'u_time', 'u_count', 'u_grid', 'u_cellCss', 'u_cell', 'u_buffer', 'u_color', 'u_glowColor', 'u_inkAlpha', 'u_now', 'u_tapCount', 'u_taps'].map(name => [name, gl.getUniformLocation(glyphProgram, name)]));
      gl.useProgram(fieldProgram);
      gl.uniform1ui(field.u_seed, profile.seed);
      gl.uniform1f(field.u_tail, config.wind.tail);
      gl.uniform1f(field.u_sweep, config.wind.sweep);
      gl.uniform1f(field.u_morph, config.wind.morph);
      gl.uniform4f(field.u_wind, profile.heading, profile.speed, profile.gustLength, profile.gustWidth);
      gl.uniform4f(field.u_gust, profile.bend, profile.bendScale, config.wind.lull, config.wind.streak);
      gl.uniform4f(field.u_shape, config.wind.detail, config.wind.edge, config.wind.curl, config.wind.wisp);
      gl.useProgram(glyphProgram);
      gl.uniform1i(glyph.u_wind, 0);
      gl.uniform1i(glyph.u_atlas, 1);
      gl.uniform1i(glyph.u_boxes, 2);
      gl.uniform1i(glyph.u_sequence, 3);
      gl.uniform1ui(glyph.u_seed, profile.seed);
      gl.uniform1f(glyph.u_fill, config.surface.fill);
      gl.uniform1f(glyph.u_flick, config.wind.flick);
      gl.uniform1f(glyph.u_friction, config.wind.friction);
      gl.uniform1f(glyph.u_glowAmount, config.glow.amount);
      root.prepend(canvas);

      const touch = createTouch();
      const { power } = config;
      const epoch = window.performance.now();
      const now = () => (window.performance.now() - epoch) / 1000;
      const colorContext = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
      if (!colorContext) { destroy(); return; }
      let grid = null;
      let atlasKey = '';
      let opacity = 0;
      let paletteKey = '';
      let visible = true;
      let activeTime = 0;
      let previousFrameAt = window.performance.now();
      let windTime = profile.seed / 4294967296 * 64;
      let revealAt = 0;
      let resumeAt = -power.resumeS;
      let settleAt = power.budgetS;
      let windAmount = 1;
      let settled = false;
      let backoff = 0;
      let suspended = false;
      let retryDelay = power.retryS;
      let lateSamples = [];
      let slowFrames = 0;
      let drawCount = 0;
      let laggingFrames = 0;
      let requestedAt = 0;

      function canRun() { return !cancelled() && !!grid && visible && !document.hidden && focusWindow.document.hasFocus() && !settled && !suspended; }

      function updateOpacity() {
        canvas.style.transition = 'opacity 500ms ease-out';
        canvas.style.opacity = String(grid && visible && !document.hidden && focusWindow.document.hasFocus() && !suspended ? opacity : 0);
      }

      function parseColor(value) {
        colorContext.clearRect(0, 0, 1, 1);
        colorContext.fillStyle = '#808080';
        colorContext.fillStyle = value;
        colorContext.fillRect(0, 0, 1, 1);
        const [red, green, blue, alpha] = colorContext.getImageData(0, 0, 1, 1).data;
        return { rgb: [red / 255, green / 255, blue / 255], alpha: alpha / 255 };
      }

      function setPalette() {
        if (cancelled()) return;
        const styles = window.getComputedStyle(root);
        const base = styles.getPropertyValue('--ascii-color').trim() || styles.color;
        const accent = styles.getPropertyValue('--ascii-glow').trim();
        const mode = styles.colorScheme.includes('light') && !styles.colorScheme.includes('dark') ? 'light' : styles.colorScheme.includes('dark') && !styles.colorScheme.includes('light') ? 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
        const nextKey = `${base}/${accent}/${mode}`;
        if (nextKey === paletteKey) return;
        paletteKey = nextKey;
        const ink = parseColor(base);
        gl.useProgram(glyphProgram);
        gl.uniform3fv(glyph.u_color, ink.rgb);
        gl.uniform1f(glyph.u_inkAlpha, ink.alpha);
        gl.uniform3fv(glyph.u_glowColor, accent ? parseColor(accent).rgb : config.glow.color[mode]);
        opacity = Math.min(1, Math.min(config.strength.base[mode] * config.strength.scale, config.strength.cap[mode]) * config.glow.headroom);
        updateOpacity();
      }

      function sendTouch(uniforms, input) {
        gl.uniform1i(uniforms.u_tapCount, input.tapCount);
        gl.uniform1f(uniforms.u_now, input.now);
        if (input.tapCount) gl.uniform4fv(uniforms.u_taps, input.taps);
        if (uniforms.u_wakeCount !== undefined) {
          gl.uniform1i(uniforms.u_wakeCount, input.wakeCount);
          if (input.wakeCount) {
            gl.uniform4fv(uniforms.u_wakes, input.wakes);
            gl.uniform4fv(uniforms.u_ways, input.ways);
          }
        }
      }

      function draw() {
        if (cancelled() || !grid) return;
        try {
          if (fence) {
            laggingFrames = gl.getSyncParameter(fence, gl.SYNC_STATUS) === gl.SIGNALED ? 0 : laggingFrames + 1;
            gl.deleteSync(fence);
            fence = null;
          }
          const input = touch.frame(now());
          gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
          gl.viewport(0, 0, grid.columns, grid.rows * 2);
          gl.useProgram(fieldProgram);
          gl.uniform1f(field.u_time, windTime);
          gl.uniform1f(field.u_reveal, smooth((activeTime - revealAt) / config.wind.revealS) * windAmount);
          sendTouch(field, input);
          gl.drawArrays(gl.TRIANGLES, 0, 3);
          gl.bindFramebuffer(gl.FRAMEBUFFER, null);
          gl.viewport(0, 0, canvas.width, canvas.height);
          gl.clearColor(0, 0, 0, 0);
          gl.clear(gl.COLOR_BUFFER_BIT);
          gl.useProgram(glyphProgram);
          gl.uniform1f(glyph.u_time, windTime);
          sendTouch(glyph, input);
          gl.drawArrays(gl.TRIANGLES, 0, 6 * grid.columns * grid.rows);
          drawCount += 1;
          if (drawCount % 4 === 0) {
            fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
            gl.flush();
          }
        } catch { destroy(); }
      }

      function schedule() {
        if (timer || frame || !canRun()) return;
        const interval = backoff > 0 ? power.backoffFrameMs : touch.rippling(now()) ? power.rippleFrameMs : power.frameMs;
        timer = window.setTimeout(() => {
          timer = 0;
          if (!canRun()) return;
          requestedAt = window.performance.now();
          frame = window.requestAnimationFrame(tick);
        }, interval);
      }

      function refresh() {
        if (!canRun()) {
          window.clearTimeout(timer);
          window.cancelAnimationFrame(frame);
          timer = 0;
          frame = 0;
        } else if (!timer && !frame) {
          previousFrameAt = window.performance.now();
          schedule();
        }
        updateOpacity();
      }

      function resume(keepBudget = false) {
        window.clearTimeout(retryTimer);
        retryTimer = 0;
        settled = false;
        suspended = false;
        backoff = 0;
        revealAt = activeTime;
        resumeAt = activeTime;
        if (!keepBudget) settleAt = activeTime + power.budgetS;
        draw();
        refresh();
      }

      function suspend() {
        suspended = true;
        refresh();
        window.clearTimeout(retryTimer);
        retryTimer = window.setTimeout(() => resume(true), retryDelay * 1000);
        retryDelay = Math.min(retryDelay * 2, power.retryMaxS);
      }

      function late() {
        backoff += 1;
        if (backoff >= 2) suspend();
      }

      function tick(timestamp) {
        frame = 0;
        if (!canRun()) return;
        const startedAt = window.performance.now();
        const targetAt = Math.max(timestamp, requestedAt);
        lateSamples = [...lateSamples.slice(-9), startedAt - targetAt > 17];
        if (lateSamples.filter(Boolean).length >= 5) { lateSamples = []; late(); }
        const elapsed = Math.min(Math.max((startedAt - previousFrameAt) / 1000, 0), 0.25);
        previousFrameAt = startedAt;
        activeTime += elapsed;
        windAmount = 1 - smooth((activeTime - settleAt) / power.settleS);
        windTime += elapsed * config.wind.energy * windAmount * smooth((activeTime - resumeAt) / power.resumeS);
        draw();
        if (windAmount === 0 && !touch.busy(now())) {
          settled = true;
          retryDelay = power.retryS;
        } else if (laggingFrames >= 2 && !suspended) {
          laggingFrames = 0;
          late();
        }
        slowFrames = window.performance.now() - targetAt > 50 ? slowFrames + 1 : 0;
        if (slowFrames >= 3) { slowFrames = 0; suspend(); }
        schedule();
      }

      function resize(measurement) {
        if (cancelled()) return;
        try {
          const scale = window.devicePixelRatio || 1;
          const width = measurement.width;
          const height = measurement.height;
          const deviceWidth = measurement.deviceWidth ?? Math.round(width * scale);
          const deviceHeight = measurement.deviceHeight ?? Math.round(height * scale);
          const cellWidth = Math.max(5, Math.round(config.grid.cellCss * scale));
          const cellHeight = cellWidth * 2;
          let columns = Math.ceil(deviceWidth / cellWidth);
          let rows = Math.ceil(deviceHeight / cellHeight);
          if (!(width > 0 && height > 0) || columns < config.grid.minCols || rows < config.grid.minRows) {
            grid = null;
            canvas.style.visibility = 'hidden';
            refresh();
            return;
          }
          const overflow = columns * cellWidth * rows * cellHeight / config.grid.maxDevicePixels;
          if (overflow > 1) { columns = Math.floor(columns / Math.sqrt(overflow)); rows = Math.floor(rows / Math.sqrt(overflow)); }
          const bufferWidth = columns * cellWidth;
          const bufferHeight = rows * cellHeight;
          const maxSize = gl.getParameter(gl.MAX_RENDERBUFFER_SIZE);
          if (bufferWidth > maxSize || bufferHeight > maxSize) throw new Error('Canvas allocation exceeds device limit');
          const left = Math.round((deviceWidth - bufferWidth) / 2);
          const top = Math.round((deviceHeight - bufferHeight) / 2);
          const nextAtlasKey = `${cellWidth}/${cellHeight}/${scale}`;
          if (atlasKey !== nextAtlasKey) {
            const atlas = createAtlas(cellWidth, cellHeight, scale, profile);
            upload(1, gl.R8, gl.RED, cellWidth * 16, cellHeight * 6, atlas.coverage);
            upload(2, gl.RGBA8UI, gl.RGBA_INTEGER, alphabet.length, 1, atlas.boxes);
            upload(3, gl.R8, gl.RED, atlas.sequence.length, 1, atlas.sequence);
            gl.useProgram(glyphProgram);
            gl.uniform1i(glyph.u_count, atlas.sequence.length);
            atlasKey = nextAtlasKey;
          }
          if (canvas.width !== bufferWidth) canvas.width = bufferWidth;
          if (canvas.height !== bufferHeight) canvas.height = bufferHeight;
          if (gl.drawingBufferWidth !== bufferWidth || gl.drawingBufferHeight !== bufferHeight) throw new Error('Canvas allocation failed');
          Object.assign(canvas.style, { left: `${left / scale}px`, top: `${top / scale}px`, width: `${bufferWidth / scale}px`, height: `${bufferHeight / scale}px`, visibility: '' });
          if (!grid || grid.columns !== columns || grid.rows !== rows) {
            upload(0, gl.RGBA8, gl.RGBA, columns, rows * 2, null);
            gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
            gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, windTexture, 0);
            if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('Framebuffer allocation failed');
          }
          grid = { columns, rows };
          gl.useProgram(fieldProgram);
          gl.uniform2f(field.u_sampleCss, cellWidth / scale, cellHeight / scale / 2);
          gl.uniform2f(field.u_originCss, left / scale, top / scale);
          gl.uniform2f(field.u_paneCss, width, height);
          gl.uniform2f(field.u_canvasCss, bufferWidth / scale, bufferHeight / scale);
          gl.useProgram(glyphProgram);
          gl.uniform2i(glyph.u_grid, columns, rows);
          gl.uniform4f(glyph.u_cellCss, (left + cellWidth / 2) / scale, (top + cellHeight / 2) / scale, cellWidth / scale, cellHeight / scale);
          gl.uniform2i(glyph.u_cell, cellWidth, cellHeight);
          gl.uniform2i(glyph.u_buffer, bufferWidth, bufferHeight);
          setPalette();
          draw();
          refresh();
        } catch { destroy(); }
      }

      function measurement(entry) {
        const box = entry?.contentBoxSize?.[0] || entry?.contentBoxSize;
        const device = entry?.devicePixelContentBoxSize?.[0] || entry?.devicePixelContentBoxSize;
        return {
          width: box?.inlineSize ?? entry?.contentRect.width ?? root.clientWidth,
          height: box?.blockSize ?? entry?.contentRect.height ?? root.clientHeight,
          deviceWidth: device?.inlineSize,
          deviceHeight: device?.blockSize,
        };
      }

      const measuredResize = entry => {
        window.clearTimeout(resizeTimer);
        const size = measurement(entry);
        if (!grid) resize(size);
        else resizeTimer = window.setTimeout(() => resize(size), power.resizeSettleMs);
      };
      if (window.ResizeObserver) {
        resizeObserver = new window.ResizeObserver(entries => measuredResize(entries[0]));
        try { resizeObserver.observe(root, { box: 'device-pixel-content-box' }); }
        catch { resizeObserver.observe(root); }
      }
      listen(window, 'resize', () => measuredResize());
      if (window.IntersectionObserver) {
        intersectionObserver = new window.IntersectionObserver(entries => {
          visible = entries[0]?.isIntersecting ?? false;
          touch.leave();
          refresh();
        });
        intersectionObserver.observe(root);
      }
      const paletteChanged = () => {
        if (paletteFrame) return;
        paletteFrame = window.requestAnimationFrame(() => {
          paletteFrame = 0;
          if (cancelled()) return;
          const previous = paletteKey;
          setPalette();
          if (previous !== paletteKey) draw();
        });
      };
      mutationObserver = new window.MutationObserver(paletteChanged);
      for (let ancestor = root; ancestor; ancestor = ancestor.parentElement) mutationObserver.observe(ancestor, { attributes: true, attributeFilter: ['class', 'style', 'data-theme', 'data-mode'] });
      listen(window.matchMedia('(prefers-color-scheme: dark)'), 'change', paletteChanged);
      const visibilityChanged = () => {
        touch.leave();
        if (settled && visible && !document.hidden && focusWindow.document.hasFocus()) resume();
        else refresh();
      };
      listen(document, 'visibilitychange', visibilityChanged);
      listen(focusWindow, 'focus', visibilityChanged);
      listen(focusWindow, 'blur', visibilityChanged);
      function wake() {
        if (settled) resume();
        else if (activeTime < settleAt) settleAt = activeTime + power.budgetS;
      }
      function point(event) {
        if (cancelled() || !grid || !visible || suspended) return null;
        const bounds = root.getBoundingClientRect();
        return [event.clientX - bounds.left, event.clientY - bounds.top];
      }
      listen(root, 'pointermove', event => {
        const position = event.pointerType === 'mouse' ? point(event) : null;
        if (!position) return;
        touch.move(...position, now());
        wake();
      }, { passive: true });
      listen(root, 'pointerdown', event => {
        const position = event.button === 0 ? point(event) : null;
        if (!position) return;
        const control = event.target instanceof window.Element ? event.target.closest(interactive) : null;
        if (!control || control === root || !root.contains(control)) touch.tap(...position, now());
        wake();
        refresh();
      }, { passive: true });
      listen(root, 'pointerleave', touch.leave, { passive: true });
      listen(root, 'keydown', () => { if (grid && visible && !suspended) wake(); }, { capture: true, passive: true });
      resize(measurement());
    }
    return { start, destroy };
  }
}

const stopAsciiWind2 = initAsciiWind2(document, 'wind');

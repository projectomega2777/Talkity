/**
 * Talkity - Cinematic 3D AI Orb Hero Background
 *
 * High-performance Three.js animated AI orb scene:
 * - Floating translucent glass sphere with chromatic Fresnel rim
 * - Pulsing procedural cyan & blue electric core
 * - Volumetric bloom coronas (cyan inner, violet outer)
 * - Animated sound-wave frequency rings expanding outward
 * - Luminous orbital & ambient particle cloud
 * - Subtle cursor parallax & cinematic camera drift
 * - Full responsive layout (desktop right-aligned, mobile centered)
 * - Reduced motion & visibility observer optimizations
 * - WebGL fallback
 */

import * as THREE from './vendor/three.module.js';

export class HeroBackground {
  constructor(options = {}) {
    this.container = options.container || document.getElementById('heroBgContainer');
    this.options = Object.assign({
      particleCount: 850,
      ringCount: 4,
      enableMouse: true,
      maxDPR: 1.75
    }, options);

    this.renderer = null;
    this.scene = null;
    this.camera = null;
    this.orbGroup = null;
    this.coreMesh = null;
    this.glassMesh = null;
    this.innerCorona = null;
    this.outerCorona = null;
    this.rings = [];
    this.particleSystem = null;

    this.clock = new THREE.Clock();
    this.rafId = null;
    this.isDestroyed = false;
    this.isPaused = false;
    this.isVisible = true;
    this.reducedMotion = false;

    this.mouse = { x: 0, y: 0, targetX: 0, targetY: 0 };
    this.width = 0;
    this.height = 0;
    this.aspect = 1;

    this.onResize = this.onResize.bind(this);
    this.onMouseMove = this.onMouseMove.bind(this);
    this.onVisibilityChange = this.onVisibilityChange.bind(this);
    this.animate = this.animate.bind(this);
  }

  static isWebGLAvailable() {
    try {
      const canvas = document.createElement('canvas');
      return !!(
        window.WebGLRenderingContext &&
        (canvas.getContext('webgl') || canvas.getContext('experimental-webgl'))
      );
    } catch (e) {
      return false;
    }
  }

  init() {
    if (!this.container) {
      console.warn('[HeroBackground] Container element not found.');
      return;
    }

    if (!HeroBackground.isWebGLAvailable()) {
      this.applyFallback('WebGL not supported');
      return;
    }

    this.reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    try {
      this.setupScene();
      this.setupLights();
      this.createCore();
      this.createGlassSphere();
      this.createSoundWaveRings();
      this.createParticles();
      this.bindEvents();
      this.updateLayout();

      if (this.reducedMotion) {
        // Render one static cinematic frame and stop
        this.renderFrame(0.5);
        this.isPaused = true;
      } else {
        this.clock.start();
        this.rafId = requestAnimationFrame(this.animate);
      }

      this.setupIntersectionObserver();
      this.container.classList.add('hero-bg--ready');
    } catch (err) {
      console.error('[HeroBackground] Initialization error:', err);
      this.applyFallback(err.message);
    }
  }

  setupScene() {
    this.width = this.container.clientWidth || window.innerWidth;
    this.height = this.container.clientHeight || (window.innerHeight * 0.9);
    this.aspect = this.width / Math.max(this.height, 1);

    this.scene = new THREE.Scene();

    // Subtle dark midnight-blue depth fog blending seamlessly into #050505
    this.scene.fog = new THREE.FogExp2(0x040814, 0.045);

    // Camera setup
    this.camera = new THREE.PerspectiveCamera(45, this.aspect, 0.1, 100);
    this.camera.position.set(0, 0, 7.8);

    // Renderer setup with DPR limit
    const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || window.innerWidth < 768;
    const maxDPR = isMobile ? 1.25 : this.options.maxDPR;
    const pixelRatio = Math.min(window.devicePixelRatio || 1, maxDPR);

    this.renderer = new THREE.WebGLRenderer({
      powerPreference: 'high-performance',
      antialias: !isMobile,
      alpha: true,
      depth: true,
      stencil: false
    });

    this.renderer.setSize(this.width, this.height);
    this.renderer.setPixelRatio(pixelRatio);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.15;

    this.canvas = this.renderer.domElement;
    this.canvas.className = 'hero-bg__canvas';
    this.canvas.setAttribute('aria-hidden', 'true');
    this.container.appendChild(this.canvas);

    // Root group for all floating components
    this.orbGroup = new THREE.Group();
    this.scene.add(this.orbGroup);
  }

  setupLights() {
    // Midnight-blue ambient base
    const ambientLight = new THREE.AmbientLight(0x060f22, 1.4);
    this.scene.add(ambientLight);

    // Electric cyan key light from upper right
    const cyanLight = new THREE.PointLight(0x00f0ff, 3.2, 20, 1.5);
    cyanLight.position.set(4, 3, 5);
    this.scene.add(cyanLight);

    // Subtle violet rim light from lower left
    const violetLight = new THREE.PointLight(0x8b5cf6, 2.8, 18, 1.6);
    violetLight.position.set(-3, -2.5, 4);
    this.scene.add(violetLight);

    // Deep blue fill light from rear
    const rearLight = new THREE.DirectionalLight(0x1e3a8a, 1.0);
    rearLight.position.set(0, 4, -5);
    this.scene.add(rearLight);
  }

  createCore() {
    // 1. Procedural Electric Core with simplex noise & chromatic plasma
    const coreGeometry = new THREE.SphereGeometry(1.05, 48, 48);

    const coreVertexShader = `
      varying vec3 vNormal;
      varying vec3 vPosition;
      varying vec2 vUv;
      varying vec3 vViewDir;

      uniform float uTime;

      // 3D Simplex noise functions for dynamic plasma pulsation
      vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
      vec4 mod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
      vec4 permute(vec4 x) { return mod289(((x*34.0)+1.0)*x); }
      vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }

      float snoise(vec3 v) {
        const vec2 C = vec2(1.0/6.0, 1.0/3.0);
        const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
        vec3 i  = floor(v + dot(v, C.yyy));
        vec3 x0 = v - i + dot(i, C.xxx);
        vec3 g = step(x0.yzx, x0.xyz);
        vec3 l = 1.0 - g;
        vec3 i1 = min(g.xyz, l.zxy);
        vec3 i2 = max(g.xyz, l.zxy);
        vec3 x1 = x0 - i1 + C.xxx;
        vec3 x2 = x0 - i2 + C.yyy;
        vec3 x3 = x0 - D.yyy;
        i = mod289(i);
        vec4 p = permute(permute(permute(
                  i.z + vec4(0.0, i1.z, i2.z, 1.0))
                + i.y + vec4(0.0, i1.y, i2.y, 1.0))
                + i.x + vec4(0.0, i1.x, i2.x, 1.0));
        float n_ = 0.142857142857;
        vec3 ns = n_ * D.wyz - D.xzx;
        vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
        vec4 x_ = floor(j * ns.z);
        vec4 y_ = floor(j - 7.0 * x_);
        vec4 x = x_ *ns.x + ns.yyyy;
        vec4 y = y_ *ns.x + ns.yyyy;
        vec4 h = 1.0 - abs(x) - abs(y);
        vec4 b0 = vec4(x.xy, y.xy);
        vec4 b1 = vec4(x.zw, y.zw);
        vec4 s0 = floor(b0)*2.0 + 1.0;
        vec4 s1 = floor(b1)*2.0 + 1.0;
        vec4 sh = -step(h, vec4(0.0));
        vec4 a0 = b0.xzyw + s0.xzyw*sh.xxyy;
        vec4 a1 = b1.xzyw + s1.xzyw*sh.zzww;
        vec3 p0 = vec3(a0.xy, h.x);
        vec3 p1 = vec3(a0.zw, h.y);
        vec3 p2 = vec3(a1.xy, h.z);
        vec3 p3 = vec3(a1.zw, h.w);
        vec4 norm = taylorInvSqrt(vec4(dot(p0,p0), dot(p1,p1), dot(p2, p2), dot(p3,p3)));
        p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
        vec4 m = max(0.6 - vec4(dot(x0,x0), dot(x1,x1), dot(x2,x2), dot(x3,x3)), 0.0);
        m = m * m;
        return 42.0 * dot(m*m, vec4(dot(p0,x0), dot(p1,x1), dot(p2,x2), dot(p3,x3)));
      }

      void main() {
        vUv = uv;
        vNormal = normalize(normalMatrix * normal);
        
        // Gentle organic surface vertex vibration
        float noise = snoise(position * 2.2 + vec3(0.0, 0.0, uTime * 0.45));
        vec3 displaced = position + normal * (noise * 0.075);
        
        vec4 mvPosition = modelViewMatrix * vec4(displaced, 1.0);
        vPosition = mvPosition.xyz;
        vViewDir = normalize(-mvPosition.xyz);
        gl_Position = projectionMatrix * mvPosition;
      }
    `;

    const coreFragmentShader = `
      varying vec3 vNormal;
      varying vec3 vPosition;
      varying vec2 vUv;
      varying vec3 vViewDir;

      uniform float uTime;

      void main() {
        // Fresnel calculation
        float fresnel = pow(1.0 - max(0.0, dot(vNormal, vViewDir)), 2.6);

        // Slow multi-phase breathing pulse
        float pulse = 0.85 + 0.15 * sin(uTime * 2.2) + 0.08 * sin(uTime * 4.4);

        // Electric cyan, deep cobalt blue, and hot white highlights
        vec3 deepBlue = vec3(0.01, 0.18, 0.65);
        vec3 electricCyan = vec3(0.0, 0.94, 1.0);
        vec3 hotCenter = vec3(0.85, 0.96, 1.0);
        vec3 violetAccent = vec3(0.55, 0.22, 0.95);

        // Procedural radial energy bands
        float bands = sin(vPosition.y * 5.0 + uTime * 3.0) * 0.5 + 0.5;
        vec3 coreColor = mix(deepBlue, electricCyan, bands * 0.7 + 0.3);
        coreColor = mix(coreColor, violetAccent, fresnel * 0.45);
        coreColor = mix(coreColor, hotCenter, pow(fresnel, 3.8) * 0.9);

        // Dynamic luminance
        vec3 finalColor = coreColor * pulse * (1.1 + fresnel * 1.5);
        gl_FragColor = vec4(finalColor, 0.96);
      }
    `;

    this.coreMaterial = new THREE.ShaderMaterial({
      vertexShader: coreVertexShader,
      fragmentShader: coreFragmentShader,
      uniforms: {
        uTime: { value: 0 }
      },
      transparent: true,
      blending: THREE.AdditiveBlending
    });

    this.coreMesh = new THREE.Mesh(coreGeometry, this.coreMaterial);
    this.orbGroup.add(this.coreMesh);

    // 2. Volumetric Bloom Coronas (inner electric cyan aura + outer violet haze)
    const coronaVertexShader = `
      varying vec3 vNormal;
      varying vec3 vViewDir;
      void main() {
        vNormal = normalize(normalMatrix * normal);
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        vViewDir = normalize(-mvPosition.xyz);
        gl_Position = projectionMatrix * mvPosition;
      }
    `;

    const coronaFragmentShader = `
      varying vec3 vNormal;
      varying vec3 vViewDir;
      uniform vec3 uColor;
      uniform float uIntensity;
      uniform float uPower;
      uniform float uTime;

      void main() {
        float fresnel = pow(max(0.0, dot(vNormal, vViewDir)), uPower);
        float pulse = 0.9 + 0.1 * sin(uTime * 2.0);
        float alpha = fresnel * uIntensity * pulse;
        gl_FragColor = vec4(uColor, alpha);
      }
    `;

    // Inner cyan corona
    const innerCoronaGeo = new THREE.SphereGeometry(1.28, 32, 32);
    this.innerCoronaMat = new THREE.ShaderMaterial({
      vertexShader: coronaVertexShader,
      fragmentShader: coronaFragmentShader,
      uniforms: {
        uColor: { value: new THREE.Color(0x00f0ff) },
        uIntensity: { value: 0.65 },
        uPower: { value: 2.2 },
        uTime: { value: 0 }
      },
      transparent: true,
      blending: THREE.AdditiveBlending,
      side: THREE.BackSide,
      depthWrite: false
    });
    this.innerCorona = new THREE.Mesh(innerCoronaGeo, this.innerCoronaMat);
    this.orbGroup.add(this.innerCorona);

    // Outer violet atmospheric haze
    const outerCoronaGeo = new THREE.SphereGeometry(1.95, 32, 32);
    this.outerCoronaMat = new THREE.ShaderMaterial({
      vertexShader: coronaVertexShader,
      fragmentShader: coronaFragmentShader,
      uniforms: {
        uColor: { value: new THREE.Color(0x7c3aed) },
        uIntensity: { value: 0.38 },
        uPower: { value: 2.8 },
        uTime: { value: 0 }
      },
      transparent: true,
      blending: THREE.AdditiveBlending,
      side: THREE.BackSide,
      depthWrite: false
    });
    this.outerCorona = new THREE.Mesh(outerCoronaGeo, this.outerCoronaMat);
    this.orbGroup.add(this.outerCorona);
  }

  createGlassSphere() {
    // Large floating translucent glass sphere with realistic Fresnel reflections
    const glassGeometry = new THREE.SphereGeometry(1.68, 64, 64);

    const glassVertexShader = `
      varying vec3 vWorldNormal;
      varying vec3 vViewDir;
      varying vec3 vWorldPosition;
      varying vec3 vNormal;

      void main() {
        vNormal = normalize(normalMatrix * normal);
        vec4 worldPos = modelMatrix * vec4(position, 1.0);
        vWorldPosition = worldPos.xyz;
        vWorldNormal = normalize((modelMatrix * vec4(normal, 0.0)).xyz);
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        vViewDir = normalize(-mvPosition.xyz);
        gl_Position = projectionMatrix * mvPosition;
      }
    `;

    const glassFragmentShader = `
      varying vec3 vWorldNormal;
      varying vec3 vViewDir;
      varying vec3 vWorldPosition;
      varying vec3 vNormal;

      uniform float uTime;
      uniform vec3 uKeyLightDir;
      uniform vec3 uRimLightDir;

      void main() {
        // Physical Fresnel rim factor
        float NdotV = max(0.0, dot(vNormal, vViewDir));
        float fresnel = pow(1.0 - NdotV, 2.7);

        // Specular studio softbox highlight 1 (Electric cyan key)
        vec3 keyHalf = normalize(uKeyLightDir + vViewDir);
        float keySpec = pow(max(0.0, dot(vNormal, keyHalf)), 48.0) * 1.8;

        // Specular studio softbox highlight 2 (Subtle violet rim)
        vec3 rimHalf = normalize(uRimLightDir + vViewDir);
        float rimSpec = pow(max(0.0, dot(vNormal, rimHalf)), 28.0) * 1.2;

        // Deep midnight translucent body
        vec3 deepMidnight = vec3(0.02, 0.05, 0.12);
        vec3 glassRimCyan = vec3(0.0, 0.95, 1.0);
        vec3 glassRimViolet = vec3(0.68, 0.35, 1.0);

        // Dynamic rim chromatic color shift
        vec3 rimColor = mix(glassRimCyan, glassRimViolet, vNormal.y * 0.5 + 0.5);

        // Combine base transmission, highlights, and glowing rim
        vec3 finalColor = deepMidnight * 0.6;
        finalColor += rimColor * (fresnel * 1.4);
        finalColor += vec3(0.85, 0.95, 1.0) * keySpec;
        finalColor += vec3(0.7, 0.5, 1.0) * rimSpec;

        // Translucent alpha that lets inner glowing core shine through
        float alpha = clamp(0.18 + fresnel * 0.72 + keySpec * 0.5, 0.0, 0.92);

        gl_FragColor = vec4(finalColor, alpha);
      }
    `;

    this.glassMaterial = new THREE.ShaderMaterial({
      vertexShader: glassVertexShader,
      fragmentShader: glassFragmentShader,
      uniforms: {
        uTime: { value: 0 },
        uKeyLightDir: { value: new THREE.Vector3(0.6, 0.7, 0.8).normalize() },
        uRimLightDir: { value: new THREE.Vector3(-0.7, -0.4, 0.5).normalize() }
      },
      transparent: true,
      blending: THREE.NormalBlending,
      depthWrite: false
    });

    this.glassMesh = new THREE.Mesh(glassGeometry, this.glassMaterial);
    this.orbGroup.add(this.glassMesh);
  }

  createSoundWaveRings() {
    // 4 Animated acoustic sound-wave rings encircling the orb at dynamic angles
    const ringVertexShader = `
      varying vec2 vUv;
      varying float vAngle;
      varying vec3 vPosition;

      uniform float uTime;
      uniform float uFrequency;
      uniform float uAmplitude;

      void main() {
        vUv = uv;
        vPosition = position;
        
        // Calculate polar angle around the ring
        float angle = atan(position.y, position.x);
        vAngle = angle;

        // Acoustic sound wave ripples modulating z-axis
        float wave = sin(angle * uFrequency + uTime * 3.2) * uAmplitude;
        vec3 displaced = position + vec3(0.0, 0.0, wave);

        gl_Position = projectionMatrix * modelViewMatrix * vec4(displaced, 1.0);
      }
    `;

    const ringFragmentShader = `
      varying vec2 vUv;
      varying float vAngle;
      varying vec3 vPosition;

      uniform float uTime;
      uniform float uProgress;
      uniform vec3 uColorStart;
      uniform vec3 uColorEnd;
      uniform float uRingIndex;

      void main() {
        // Radial thickness envelope: smooth falloff at inner & outer edges
        float distFromCenter = abs(vUv.y - 0.5) * 2.0;
        float radialAlpha = smoothstep(1.0, 0.0, distFromCenter);

        // Acoustic frequency bars pulsation along circumference
        float freqPulse = sin(vAngle * (6.0 + uRingIndex * 2.0) - uTime * 2.5) * 0.5 + 0.5;
        float waveAlpha = 0.65 + 0.35 * freqPulse;

        // Continuous expansion fade envelope (fade-in, peak, fade-out smoothly)
        float lifeFade = sin(uProgress * 3.14159265);

        // Gradient from electric cyan to subtle violet
        vec3 ringColor = mix(uColorStart, uColorEnd, vUv.y * 0.7 + freqPulse * 0.3);

        float finalAlpha = radialAlpha * waveAlpha * lifeFade * 0.75;
        gl_FragColor = vec4(ringColor, finalAlpha);
      }
    `;

    const ringConfigs = [
      { radius: 1.82, tiltX: 0.35, tiltY: 0.15, freq: 8.0, amp: 0.065, speed: 0.32, offset: 0.0 },
      { radius: 2.15, tiltX: -0.28, tiltY: 0.42, freq: 10.0, amp: 0.055, speed: 0.28, offset: 0.25 },
      { radius: 2.48, tiltX: 0.45, tiltY: -0.32, freq: 12.0, amp: 0.045, speed: 0.24, offset: 0.5 },
      { radius: 2.85, tiltX: -0.18, tiltY: -0.52, freq: 14.0, amp: 0.038, speed: 0.20, offset: 0.75 }
    ];

    this.rings = [];
    this.ringGroup = new THREE.Group();
    this.orbGroup.add(this.ringGroup);

    ringConfigs.forEach((cfg, idx) => {
      // Ring width: 0.06 to 0.08
      const ringGeo = new THREE.RingGeometry(cfg.radius, cfg.radius + 0.08, 128);
      
      const ringMat = new THREE.ShaderMaterial({
        vertexShader: ringVertexShader,
        fragmentShader: ringFragmentShader,
        uniforms: {
          uTime: { value: 0 },
          uProgress: { value: cfg.offset },
          uFrequency: { value: cfg.freq },
          uAmplitude: { value: cfg.amp },
          uColorStart: { value: new THREE.Color(0x00f0ff) },
          uColorEnd: { value: new THREE.Color(0x8b5cf6) },
          uRingIndex: { value: idx }
        },
        transparent: true,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
        depthWrite: false
      });

      const ringMesh = new THREE.Mesh(ringGeo, ringMat);
      ringMesh.rotation.x = cfg.tiltX * Math.PI;
      ringMesh.rotation.y = cfg.tiltY * Math.PI;

      this.ringGroup.add(ringMesh);
      this.rings.push({
        mesh: ringMesh,
        material: ringMat,
        config: cfg,
        baseRadius: cfg.radius
      });
    });
  }

  createParticles() {
    // Swarm of luminous particles orbiting organically around the sphere
    const count = this.options.particleCount;
    const geometry = new THREE.BufferGeometry();

    const positions = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);
    const sizes = new Float32Array(count);
    const orbitData = new Float32Array(count * 4); // [radius, speed, tiltX, tiltY]
    const phases = new Float32Array(count);

    const cyan = new THREE.Color(0x00f0ff);
    const iceBlue = new THREE.Color(0x60a5fa);
    const violet = new THREE.Color(0xa78bfa);

    for (let i = 0; i < count; i++) {
      // Stratified distribution: 65% orbiting near orb, 35% floating in ambient midnight space
      const isOrbital = i < count * 0.65;
      const radius = isOrbital
        ? 1.5 + Math.random() * 2.2
        : 2.8 + Math.random() * 4.2;

      const angle = Math.random() * Math.PI * 2;
      const tiltX = (Math.random() - 0.5) * 1.2;
      const tiltY = (Math.random() - 0.5) * 1.2;
      const speed = (0.25 + Math.random() * 0.65) * (Math.random() > 0.4 ? 1 : -1);

      // Initial coordinates
      positions[i * 3 + 0] = Math.cos(angle) * radius;
      positions[i * 3 + 1] = Math.sin(angle) * radius * 0.85 + tiltX;
      positions[i * 3 + 2] = (Math.random() - 0.5) * 2.0;

      // Color distribution: electric cyan, glowing blue, subtle violet
      const pick = Math.random();
      const pColor = pick < 0.55 ? cyan : (pick < 0.85 ? iceBlue : violet);
      colors[i * 3 + 0] = pColor.r;
      colors[i * 3 + 1] = pColor.g;
      colors[i * 3 + 2] = pColor.b;

      sizes[i] = 2.4 + Math.random() * 4.2;
      phases[i] = Math.random() * Math.PI * 2;

      orbitData[i * 4 + 0] = radius;
      orbitData[i * 4 + 1] = speed;
      orbitData[i * 4 + 2] = tiltX;
      orbitData[i * 4 + 3] = tiltY;
    }

    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geometry.setAttribute('size', new THREE.BufferAttribute(sizes, 1));
    geometry.setAttribute('aOrbit', new THREE.BufferAttribute(orbitData, 4));
    geometry.setAttribute('aPhase', new THREE.BufferAttribute(phases, 1));

    // Custom GPU particle vertex and fragment shader
    const particleVertexShader = `
      attribute float size;
      attribute vec4 aOrbit;
      attribute float aPhase;
      varying vec3 vColor;
      varying float vAlpha;

      uniform float uTime;

      void main() {
        vColor = color;
        
        float radius = aOrbit.x;
        float speed = aOrbit.y;
        float tiltX = aOrbit.z;
        float tiltY = aOrbit.w;

        // Organic orbital motion around the AI orb
        float angle = aPhase + uTime * speed * 0.35;
        
        // Helical drift + gentle sine wave vertical breathing
        vec3 pos;
        pos.x = cos(angle) * radius;
        pos.z = sin(angle) * radius * cos(tiltY) + sin(uTime * 0.5 + aPhase) * 0.3;
        pos.y = sin(angle) * radius * sin(tiltX) + cos(uTime * 0.6 + aPhase) * 0.4;

        vec4 mvPosition = modelViewMatrix * vec4(pos, 1.0);
        
        // Depth-based size attenuation and twinkle
        float twinkle = 0.75 + 0.25 * sin(uTime * 3.5 + aPhase * 4.0);
        gl_PointSize = size * twinkle * (180.0 / -mvPosition.z);
        
        // Soft depth fade
        vAlpha = smoothstep(-14.0, -2.0, mvPosition.z) * twinkle;

        gl_Position = projectionMatrix * mvPosition;
      }
    `;

    const particleFragmentShader = `
      varying vec3 vColor;
      varying float vAlpha;

      void main() {
        // Radial soft circular point sprite
        vec2 coord = gl_PointCoord - vec2(0.5);
        float dist = length(coord);
        if (dist > 0.5) discard;

        // Soft exponential glow falloff
        float intensity = pow(1.0 - dist * 2.0, 1.8);
        gl_FragColor = vec4(vColor, intensity * vAlpha * 0.85);
      }
    `;

    this.particleMaterial = new THREE.ShaderMaterial({
      vertexShader: particleVertexShader,
      fragmentShader: particleFragmentShader,
      uniforms: {
        uTime: { value: 0 }
      },
      transparent: true,
      blending: THREE.AdditiveBlending,
      vertexColors: true,
      depthWrite: false
    });

    this.particleSystem = new THREE.Points(geometry, this.particleMaterial);
    this.orbGroup.add(this.particleSystem);
  }

  updateLayout() {
    if (!this.container || !this.renderer || !this.camera) return;

    this.width = this.container.clientWidth || window.innerWidth;
    this.height = this.container.clientHeight || (window.innerHeight * 0.9);
    this.aspect = this.width / Math.max(this.height, 1);

    this.camera.aspect = this.aspect;
    this.camera.updateProjectionMatrix();

    this.renderer.setSize(this.width, this.height);

    // COMPOSITION RULE:
    // Desktop: Position orb slightly right of centre (keeping left 40% dark for text).
    // Tablet/Mobile: Center or subtly scale orb so it sits gracefully behind the hero HUD.
    if (this.orbGroup) {
      if (this.width >= 1024) {
        // Desktop 16:9 view: orb offset to right
        const offsetX = Math.min(2.1, 1.2 + (this.width / 1920) * 0.9);
        this.orbGroup.position.set(offsetX, 0.05, 0);
        this.orbGroup.scale.setScalar(1.0);
      } else if (this.width >= 768) {
        // Tablet: gentle right offset
        this.orbGroup.position.set(1.0, 0.2, 0);
        this.orbGroup.scale.setScalar(0.88);
      } else {
        // Mobile: center orb with comfortable scale
        this.orbGroup.position.set(0, 0.35, 0);
        this.orbGroup.scale.setScalar(0.72);
      }
    }
  }

  onMouseMove(e) {
    if (!this.options.enableMouse) return;
    const clientX = e.clientX || (e.touches && e.touches[0] ? e.touches[0].clientX : window.innerWidth / 2);
    const clientY = e.clientY || (e.touches && e.touches[0] ? e.touches[0].clientY : window.innerHeight / 2);

    this.mouse.targetX = (clientX / window.innerWidth) * 2 - 1;
    this.mouse.targetY = -(clientY / window.innerHeight) * 2 + 1;
  }

  onResize() {
    this.updateLayout();
  }

  onVisibilityChange() {
    if (document.hidden) {
      this.isVisible = false;
      this.pause();
    } else {
      this.isVisible = true;
      if (!this.reducedMotion) {
        this.resume();
      }
    }
  }

  setupIntersectionObserver() {
    if (!('IntersectionObserver' in window)) return;

    this.intersectionObserver = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          if (!this.reducedMotion && this.isVisible) {
            this.resume();
          }
        } else {
          // Hero scrolled out of view: pause render loop to consume 0% GPU
          this.pause();
        }
      });
    }, { threshold: 0.05 });

    this.intersectionObserver.observe(this.container);
  }

  bindEvents() {
    window.addEventListener('resize', this.onResize, { passive: true });
    window.addEventListener('mousemove', this.onMouseMove, { passive: true });
    window.addEventListener('touchmove', this.onMouseMove, { passive: true });
    document.addEventListener('visibilitychange', this.onVisibilityChange, { passive: true });
  }

  unbindEvents() {
    window.removeEventListener('resize', this.onResize);
    window.removeEventListener('mousemove', this.onMouseMove);
    window.removeEventListener('touchmove', this.onMouseMove);
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
    if (this.intersectionObserver) {
      this.intersectionObserver.disconnect();
    }
  }

  renderFrame(t) {
    // Subtle mouse lerp for smooth damping
    this.mouse.x += (this.mouse.targetX - this.mouse.x) * 0.045;
    this.mouse.y += (this.mouse.targetY - this.mouse.y) * 0.045;

    // 1. Orb floating motion (sinusoidal levitation + gentle Lissajous sway)
    const floatY = Math.sin(t * 0.85) * 0.14;
    const floatX = Math.cos(t * 0.65) * 0.07;
    
    if (this.orbGroup) {
      const basePosX = (this.width >= 1024) ? Math.min(2.1, 1.2 + (this.width / 1920) * 0.9) : (this.width >= 768 ? 1.0 : 0);
      const basePosY = (this.width < 768) ? 0.35 : 0.05;

      this.orbGroup.position.x = basePosX + floatX + this.mouse.x * 0.35;
      this.orbGroup.position.y = basePosY + floatY + this.mouse.y * 0.25;

      // Gentle responsive tilt
      this.orbGroup.rotation.y = t * 0.12 + this.mouse.x * 0.22;
      this.orbGroup.rotation.x = Math.sin(t * 0.5) * 0.06 - this.mouse.y * 0.18;
    }

    // 2. Slow cinematic camera drift
    if (this.camera) {
      this.camera.position.x = Math.sin(t * 0.18) * 0.12 + this.mouse.x * 0.15;
      this.camera.position.y = Math.cos(t * 0.22) * 0.08 + this.mouse.y * 0.12;
      this.camera.lookAt(
        (this.width >= 1024 ? 1.2 : 0) + this.mouse.x * 0.1,
        this.mouse.y * 0.1,
        0
      );
    }

    // 3. Update Core & Corona Shader Uniforms
    if (this.coreMaterial) {
      this.coreMaterial.uniforms.uTime.value = t;
    }
    if (this.innerCoronaMat) {
      this.innerCoronaMat.uniforms.uTime.value = t;
    }
    if (this.outerCoronaMat) {
      this.outerCoronaMat.uniforms.uTime.value = t;
    }
    if (this.glassMaterial) {
      this.glassMaterial.uniforms.uTime.value = t;
    }

    // 4. Update Sound-Wave Rings (continuous outward expansion without jumps)
    this.rings.forEach((ring, idx) => {
      // Progress cycles smoothly from 0.0 to 1.0
      const cycle = (t * ring.config.speed + ring.config.offset) % 1.0;
      ring.material.uniforms.uTime.value = t;
      ring.material.uniforms.uProgress.value = cycle;

      // Outward dynamic expansion
      const scale = 1.0 + cycle * 0.48;
      ring.mesh.scale.set(scale, scale, 1.0);

      // Slow counter-rotation
      ring.mesh.rotation.z = t * (0.05 * (idx % 2 === 0 ? 1 : -1));
    });

    // 5. Update Particle Shader
    if (this.particleMaterial) {
      this.particleMaterial.uniforms.uTime.value = t;
    }

    this.renderer.render(this.scene, this.camera);
  }

  animate() {
    if (this.isDestroyed || this.isPaused) return;

    const t = this.clock.getElapsedTime();
    this.renderFrame(t);

    this.rafId = requestAnimationFrame(this.animate);
  }

  pause() {
    this.isPaused = true;
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  resume() {
    if (this.isDestroyed || !this.isPaused) return;
    this.isPaused = false;
    this.clock.start();
    this.rafId = requestAnimationFrame(this.animate);
  }

  applyFallback(reason) {
    console.info(`[HeroBackground] Using fallback (${reason}).`);
    if (this.container) {
      this.container.classList.add('hero-bg--fallback');
      this.container.innerHTML = `
        <div class="hero-bg__ambient-fallback">
          <div class="hero-bg__fallback-core" aria-hidden="true"></div>
          <div class="hero-bg__fallback-glow" aria-hidden="true"></div>
          <div class="hero-bg__fallback-rings" aria-hidden="true"></div>
        </div>
      `;
    }
  }

  destroy() {
    this.isDestroyed = true;
    this.pause();
    this.unbindEvents();

    if (this.renderer) {
      this.renderer.dispose();
      if (this.canvas && this.canvas.parentNode) {
        this.canvas.parentNode.removeChild(this.canvas);
      }
    }

    // Dispose geometries and materials
    if (this.scene) {
      this.scene.traverse((obj) => {
        if (obj.geometry) obj.geometry.dispose();
        if (obj.material) {
          if (Array.isArray(obj.material)) {
            obj.material.forEach(m => m.dispose());
          } else {
            obj.material.dispose();
          }
        }
      });
    }

    this.renderer = null;
    this.scene = null;
    this.camera = null;
    this.orbGroup = null;
  }
}

// Default export for modern modular imports
export default HeroBackground;

// Also expose on window for easy legacy integration
if (typeof window !== 'undefined') {
  window.HeroBackground = HeroBackground;
}

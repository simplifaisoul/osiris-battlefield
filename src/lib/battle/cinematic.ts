import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';

// Vignette + film grain + subtle chromatic aberration for a cinematic look.
export function makeCinematicPass(): ShaderPass {
	return new ShaderPass({
		uniforms: {
			tDiffuse: { value: null },
			time: { value: 0 },
			vignette: { value: 1.15 },
			grain: { value: 0.06 },
			aberration: { value: 0.0016 },
			flash: { value: 0 }
		},
		vertexShader: `
			varying vec2 vUv;
			void main() {
				vUv = uv;
				gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
			}
		`,
		fragmentShader: `
			uniform sampler2D tDiffuse;
			uniform float time;
			uniform float vignette;
			uniform float grain;
			uniform float aberration;
			uniform float flash;
			varying vec2 vUv;

			float hash(vec2 p) {
				return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
			}

			void main() {
				vec2 uv = vUv;
				vec2 dir = uv - 0.5;
				float d = length(dir);

				// chromatic aberration grows toward edges
				float a = aberration * (0.3 + d * 2.0);
				vec3 col;
				col.r = texture2D(tDiffuse, uv - dir * a).r;
				col.g = texture2D(tDiffuse, uv).g;
				col.b = texture2D(tDiffuse, uv + dir * a).b;

				// vignette
				float vig = smoothstep(0.9, 0.25, d * vignette);
				col *= mix(0.55, 1.0, vig);

				// film grain
				float g = hash(uv * vec2(1920.0, 1080.0) + time) - 0.5;
				col += g * grain;

				// battle flash (white pulse on god descent / victory)
				col += flash * vec3(1.0, 0.92, 0.7);

				gl_FragColor = vec4(col, 1.0);
			}
		`
	});
}

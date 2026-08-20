import {
	mat3FromMat4,
	mat4Multiply,
	mat4Perspective,
	mat4RotationX,
	mat4RotationY,
	mat4Translation,
} from "./mat4";
import type { StlMesh } from "./stl-parse";

export interface StlCamera {
	/** Rotation about the model's own up axis, radians. */
	yaw: number;
	pitch: number;
	/** Distance from the model centre, in model units. */
	distance: number;
	panX: number;
	panY: number;
}

export interface StlScene {
	/**
	 * Distance at which the whole model is in frame at the given viewport
	 * aspect ratio. A portrait viewport - the file viewer on a phone - has the
	 * narrower field of view horizontally, so the fit cannot be a constant.
	 */
	fitDistanceFor(aspect: number): number;
	readonly radius: number;
	draw(camera: StlCamera, width: number, height: number): void;
	dispose(): void;
}

const VERTEX_SHADER = `
attribute vec3 aPosition;
attribute vec3 aNormal;
uniform mat4 uModelView;
uniform mat4 uProjection;
uniform mat3 uNormalMatrix;
varying vec3 vNormal;
varying vec3 vViewPos;
void main() {
  vec4 viewPos = uModelView * vec4(aPosition, 1.0);
  vViewPos = viewPos.xyz;
  vNormal = uNormalMatrix * aNormal;
  gl_Position = uProjection * viewPos;
}
`;

const FRAGMENT_SHADER = `
precision mediump float;
uniform vec3 uColor;
varying vec3 vNormal;
varying vec3 vViewPos;
void main() {
  vec3 n = normalize(vNormal);
  vec3 v = normalize(-vViewPos);
  // Winding is not reliable in the wild, and a mesh with inside-out triangles
  // must not come out as black holes: light whichever side faces the camera.
  if (dot(n, v) < 0.0) n = -n;
  float key = max(dot(n, normalize(vec3(0.35, 0.6, 0.72))), 0.0);
  float fill = max(dot(n, normalize(vec3(-0.6, -0.25, 0.4))), 0.0) * 0.3;
  float rim = pow(1.0 - max(dot(n, v), 0.0), 3.0) * 0.3;
  gl_FragColor = vec4(uColor * (0.22 + 0.78 * key + fill) + vec3(rim), 1.0);
}
`;

const FOV_Y = (45 * Math.PI) / 180;

/** Model units covered by one CSS pixel at a given camera distance - what a pan drag moves by. */
export function worldPerPixel(distance: number, heightPx: number): number {
	if (heightPx <= 0) return 0;
	return (2 * distance * Math.tan(FOV_Y / 2)) / heightPx;
}
const MODEL_COLOR: [number, number, number] = [0.53, 0.6, 0.69];

function compile(
	gl: WebGLRenderingContext,
	type: number,
	source: string,
): WebGLShader {
	const shader = gl.createShader(type);
	if (!shader) throw new Error("Could not create shader");
	gl.shaderSource(shader, source);
	gl.compileShader(shader);
	if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
		const log = gl.getShaderInfoLog(shader);
		gl.deleteShader(shader);
		throw new Error(`Shader compile failed: ${log}`);
	}
	return shader;
}

export function createStlScene(
	gl: WebGLRenderingContext,
	mesh: StlMesh,
): StlScene {
	const vertexShader = compile(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
	const fragmentShader = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
	const program = gl.createProgram();
	if (!program) throw new Error("Could not create program");
	gl.attachShader(program, vertexShader);
	gl.attachShader(program, fragmentShader);
	gl.linkProgram(program);
	if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
		throw new Error(`Program link failed: ${gl.getProgramInfoLog(program)}`);
	}

	const positionBuffer = gl.createBuffer();
	gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
	gl.bufferData(gl.ARRAY_BUFFER, mesh.positions, gl.STATIC_DRAW);
	const normalBuffer = gl.createBuffer();
	gl.bindBuffer(gl.ARRAY_BUFFER, normalBuffer);
	gl.bufferData(gl.ARRAY_BUFFER, mesh.normals, gl.STATIC_DRAW);

	const aPosition = gl.getAttribLocation(program, "aPosition");
	const aNormal = gl.getAttribLocation(program, "aNormal");
	const uModelView = gl.getUniformLocation(program, "uModelView");
	const uProjection = gl.getUniformLocation(program, "uProjection");
	const uNormalMatrix = gl.getUniformLocation(program, "uNormalMatrix");
	const uColor = gl.getUniformLocation(program, "uColor");

	const center: [number, number, number] = [
		(mesh.min[0] + mesh.max[0]) / 2,
		(mesh.min[1] + mesh.max[1]) / 2,
		(mesh.min[2] + mesh.max[2]) / 2,
	];
	// The bounding sphere, not half the box diagonal: for anything rounded the
	// diagonal overstates the size by up to sqrt(3) and the model then sits in
	// the middle of the frame surrounded by empty space.
	let boundingRadius = 0;
	for (let i = 0; i < mesh.positions.length; i += 3) {
		const distance = Math.hypot(
			(mesh.positions[i] as number) - center[0],
			(mesh.positions[i + 1] as number) - center[1],
			(mesh.positions[i + 2] as number) - center[2],
		);
		if (distance > boundingRadius) boundingRadius = distance;
	}
	// A single-point or empty mesh still needs a camera that can be moved.
	const radius = boundingRadius > 0 ? boundingRadius : 1;
	const vertexCount = mesh.triangleCount * 3;

	gl.enable(gl.DEPTH_TEST);
	gl.clearColor(0, 0, 0, 0);

	return {
		radius,
		fitDistanceFor(aspect) {
			const halfVertical = FOV_Y / 2;
			const halfHorizontal = Math.atan(
				Math.tan(halfVertical) * Math.max(aspect, 0.01),
			);
			// 6 percent of margin so the silhouette does not touch the edge.
			return (radius * 1.06) / Math.sin(Math.min(halfVertical, halfHorizontal));
		},
		draw(camera, width, height) {
			gl.viewport(0, 0, width, height);
			gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
			if (vertexCount === 0) return;

			const distance = Math.max(camera.distance, radius * 0.01);
			const projection = mat4Perspective(
				FOV_Y,
				height > 0 ? width / height : 1,
				Math.max(distance - radius * 2, radius * 0.01),
				distance + radius * 4,
			);
			// Model space is centred first, then rotated, then pushed away from
			// the eye; panning slides the result across the near plane.
			const modelView = mat4Multiply(
				mat4Translation(camera.panX, camera.panY, -distance),
				mat4Multiply(
					mat4Multiply(mat4RotationX(camera.pitch), mat4RotationY(camera.yaw)),
					mat4Translation(-center[0], -center[1], -center[2]),
				),
			);

			gl.useProgram(program);
			gl.uniformMatrix4fv(uModelView, false, modelView);
			gl.uniformMatrix4fv(uProjection, false, projection);
			gl.uniformMatrix3fv(uNormalMatrix, false, mat3FromMat4(modelView));
			gl.uniform3fv(uColor, MODEL_COLOR);

			gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
			gl.enableVertexAttribArray(aPosition);
			gl.vertexAttribPointer(aPosition, 3, gl.FLOAT, false, 0, 0);
			gl.bindBuffer(gl.ARRAY_BUFFER, normalBuffer);
			gl.enableVertexAttribArray(aNormal);
			gl.vertexAttribPointer(aNormal, 3, gl.FLOAT, false, 0, 0);

			gl.drawArrays(gl.TRIANGLES, 0, vertexCount);
		},
		dispose() {
			gl.deleteBuffer(positionBuffer);
			gl.deleteBuffer(normalBuffer);
			gl.deleteProgram(program);
			gl.deleteShader(vertexShader);
			gl.deleteShader(fragmentShader);
		},
	};
}

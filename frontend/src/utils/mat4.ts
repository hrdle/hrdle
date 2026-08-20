/**
 * The 4x4 matrix arithmetic the STL preview needs, in WebGL's column-major
 * order. Only what a rotate-and-translate camera uses is here - a matrix
 * library is a large dependency to carry for six functions.
 */

export type Mat4 = Float32Array;

export function mat4Identity(): Mat4 {
	// biome-ignore format: matrix rows
	return new Float32Array([
		1, 0, 0, 0,
		0, 1, 0, 0,
		0, 0, 1, 0,
		0, 0, 0, 1,
	]);
}

/** out = a * b (column vectors, so `b` is applied first). */
export function mat4Multiply(a: Mat4, b: Mat4): Mat4 {
	const out = new Float32Array(16);
	for (let col = 0; col < 4; col++) {
		for (let row = 0; row < 4; row++) {
			let sum = 0;
			for (let k = 0; k < 4; k++) {
				sum += (a[k * 4 + row] as number) * (b[col * 4 + k] as number);
			}
			out[col * 4 + row] = sum;
		}
	}
	return out;
}

export function mat4Translation(x: number, y: number, z: number): Mat4 {
	const out = mat4Identity();
	out[12] = x;
	out[13] = y;
	out[14] = z;
	return out;
}

export function mat4RotationX(rad: number): Mat4 {
	const c = Math.cos(rad);
	const s = Math.sin(rad);
	const out = mat4Identity();
	out[5] = c;
	out[6] = s;
	out[9] = -s;
	out[10] = c;
	return out;
}

export function mat4RotationY(rad: number): Mat4 {
	const c = Math.cos(rad);
	const s = Math.sin(rad);
	const out = mat4Identity();
	out[0] = c;
	out[2] = -s;
	out[8] = s;
	out[10] = c;
	return out;
}

export function mat4Perspective(
	fovYRadians: number,
	aspect: number,
	near: number,
	far: number,
): Mat4 {
	const f = 1 / Math.tan(fovYRadians / 2);
	const out = new Float32Array(16);
	out[0] = f / aspect;
	out[5] = f;
	out[10] = (far + near) / (near - far);
	out[11] = -1;
	out[14] = (2 * far * near) / (near - far);
	return out;
}

/** The upper-left 3x3 block, which is the normal matrix while the transform is rotation and translation only. */
export function mat3FromMat4(m: Mat4): Float32Array {
	const out = new Float32Array(9);
	for (let col = 0; col < 3; col++) {
		for (let row = 0; row < 3; row++) {
			out[col * 3 + row] = m[col * 4 + row] as number;
		}
	}
	return out;
}

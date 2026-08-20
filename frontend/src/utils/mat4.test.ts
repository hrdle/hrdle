import { describe, expect, test } from "bun:test";
import {
	mat4Identity,
	mat4Multiply,
	mat4Orthonormalize,
	mat4RotationX,
	mat4RotationY,
} from "./mat4";

function column(m: Float32Array, index: number): [number, number, number] {
	return [
		m[index * 4] as number,
		m[index * 4 + 1] as number,
		m[index * 4 + 2] as number,
	];
}

function length(v: [number, number, number]): number {
	return Math.hypot(v[0], v[1], v[2]);
}

function dot(a: [number, number, number], b: [number, number, number]): number {
	return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

describe("mat4Multiply", () => {
	test("identity leaves a matrix alone", () => {
		const rotation = mat4RotationY(0.7);
		expect([...mat4Multiply(mat4Identity(), rotation)]).toEqual([...rotation]);
		expect([...mat4Multiply(rotation, mat4Identity())]).toEqual([...rotation]);
	});

	test("applies the right-hand matrix first", () => {
		// A point on +Z, turned a quarter turn about Y, lands on +X.
		const m = mat4Multiply(mat4Identity(), mat4RotationY(Math.PI / 2));
		const [x, y, z] = column(m, 2);
		expect(x).toBeCloseTo(1, 5);
		expect(y).toBeCloseTo(0, 5);
		expect(z).toBeCloseTo(0, 5);
	});
});

describe("mat4Orthonormalize", () => {
	test("leaves a rotation as it found it", () => {
		const rotation = mat4RotationX(0.4);
		const cleaned = mat4Orthonormalize(rotation);
		for (let i = 0; i < 16; i++) {
			expect(cleaned[i] as number).toBeCloseTo(rotation[i] as number, 5);
		}
	});

	// The orientation of a dragged model is thousands of products deep by the
	// end of a session; without this the basis shears and the model with it.
	test("keeps a long chain of rotations square and unit-length", () => {
		let orientation = mat4Identity();
		for (let step = 0; step < 5000; step++) {
			const spin = mat4Multiply(
				mat4RotationX(0.013 * ((step % 7) - 3)),
				mat4RotationY(0.011 * ((step % 5) - 2)),
			);
			orientation = mat4Orthonormalize(mat4Multiply(spin, orientation));
		}
		const x = column(orientation, 0);
		const y = column(orientation, 1);
		const z = column(orientation, 2);
		expect(length(x)).toBeCloseTo(1, 4);
		expect(length(y)).toBeCloseTo(1, 4);
		expect(length(z)).toBeCloseTo(1, 4);
		expect(dot(x, y)).toBeCloseTo(0, 4);
		expect(dot(x, z)).toBeCloseTo(0, 4);
		expect(dot(y, z)).toBeCloseTo(0, 4);
	});

	test("a degenerate basis falls back to identity rather than to NaN", () => {
		const collapsed = new Float32Array(16);
		collapsed[15] = 1;
		expect([...mat4Orthonormalize(collapsed)]).toEqual([...mat4Identity()]);
	});
});

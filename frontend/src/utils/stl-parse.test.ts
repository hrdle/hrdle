import { describe, expect, test } from "bun:test";
import { parseStl } from "./stl-parse";

/** One triangle in the XY plane, wound counter-clockwise (normal +Z). */
const TRIANGLE = {
	vertices: [0, 0, 0, 1, 0, 0, 0, 1, 0],
	normal: [0, 0, 1],
};

function binaryStl(
	triangles: { vertices: number[]; normal: number[] }[],
	header = "binary test",
): ArrayBuffer {
	const buffer = new ArrayBuffer(84 + triangles.length * 50);
	const view = new DataView(buffer);
	const bytes = new Uint8Array(buffer);
	bytes.set(new TextEncoder().encode(header).subarray(0, 80), 0);
	view.setUint32(80, triangles.length, true);
	triangles.forEach((triangle, index) => {
		const base = 84 + index * 50;
		triangle.normal.forEach((value, i) => {
			view.setFloat32(base + i * 4, value, true);
		});
		triangle.vertices.forEach((value, i) => {
			view.setFloat32(base + 12 + i * 4, value, true);
		});
	});
	return buffer;
}

function asciiStl(body: string): ArrayBuffer {
	return new TextEncoder().encode(body).buffer as ArrayBuffer;
}

const ASCII_ONE_TRIANGLE = `solid test
  facet normal 0 0 1
    outer loop
      vertex 0 0 0
      vertex 1 0 0
      vertex 0 1 0
    endloop
  endfacet
endsolid test
`;

describe("parseStl", () => {
	test("reads a binary mesh with its normals and bounds", () => {
		const mesh = parseStl(binaryStl([TRIANGLE]));
		expect(mesh.format).toBe("binary");
		expect(mesh.triangleCount).toBe(1);
		expect([...mesh.positions]).toEqual(TRIANGLE.vertices);
		expect([...mesh.normals]).toEqual([0, 0, 1, 0, 0, 1, 0, 0, 1]);
		expect(mesh.min).toEqual([0, 0, 0]);
		expect(mesh.max).toEqual([1, 1, 0]);
	});

	test("reads an ASCII mesh", () => {
		const mesh = parseStl(asciiStl(ASCII_ONE_TRIANGLE));
		expect(mesh.format).toBe("ascii");
		expect(mesh.triangleCount).toBe(1);
		expect([...mesh.positions]).toEqual(TRIANGLE.vertices);
	});

	// A binary file is free to open with the ASCII keyword, and exporters do it.
	test("a binary file whose header says 'solid' is still read as binary", () => {
		const mesh = parseStl(
			binaryStl([TRIANGLE], "solid exported by a CAD tool"),
		);
		expect(mesh.format).toBe("binary");
		expect(mesh.triangleCount).toBe(1);
	});

	// A zero normal shades the face black, so the winding has to supply one.
	test("computes the normal when the file stores a zero one", () => {
		const mesh = parseStl(
			binaryStl([{ vertices: TRIANGLE.vertices, normal: [0, 0, 0] }]),
		);
		expect([...mesh.normals.slice(0, 3)]).toEqual([0, 0, 1]);
	});

	test("normalizes a stored normal that is not unit length", () => {
		const mesh = parseStl(
			binaryStl([{ vertices: TRIANGLE.vertices, normal: [0, 0, 5] }]),
		);
		expect([...mesh.normals.slice(0, 3)]).toEqual([0, 0, 1]);
	});

	test("survives a degenerate triangle rather than emitting NaN", () => {
		const mesh = parseStl(
			binaryStl([{ vertices: [1, 1, 1, 1, 1, 1, 1, 1, 1], normal: [0, 0, 0] }]),
		);
		expect([...mesh.normals].every(Number.isFinite)).toBe(true);
	});

	test("reads every triangle of a multi-triangle ASCII mesh", () => {
		const mesh = parseStl(
			asciiStl(`solid two
facet normal 0 0 1
outer loop
vertex 0 0 0
vertex 1 0 0
vertex 0 1 0
endloop
endfacet
facet normal 0 0 -1
outer loop
vertex 0 0 2
vertex 0 1 2
vertex 1 0 2
endloop
endfacet
endsolid two`),
		);
		expect(mesh.triangleCount).toBe(2);
		expect(mesh.max).toEqual([1, 1, 2]);
	});

	test("an empty binary mesh has zeroed bounds instead of infinities", () => {
		const mesh = parseStl(binaryStl([]));
		expect(mesh.triangleCount).toBe(0);
		expect(mesh.min).toEqual([0, 0, 0]);
		expect(mesh.max).toEqual([0, 0, 0]);
	});

	test("rejects a file that is not an STL", () => {
		expect(() => parseStl(asciiStl("hello, world"))).toThrow();
		expect(() => parseStl(new ArrayBuffer(0))).toThrow();
	});
});

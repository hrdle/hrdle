/**
 * STL mesh parsing for the file viewer's 3D preview.
 *
 * Both encodings of the format are here because a file cannot be trusted to
 * announce which one it is: a binary STL is free to begin with the ASCII
 * keyword `solid`, and plenty written by CAD exporters do. The declared
 * triangle count is what separates them - only a binary file's byte length
 * matches its own header.
 */

export interface StlMesh {
	/** 9 floats per triangle (three vertices, x/y/z each). */
	positions: Float32Array;
	/** Face normal repeated for each of the triangle's three vertices. */
	normals: Float32Array;
	triangleCount: number;
	min: [number, number, number];
	max: [number, number, number];
	format: "binary" | "ascii";
}

const BINARY_HEADER_BYTES = 84;
const BINARY_TRIANGLE_BYTES = 50;

function isBinaryStl(buffer: ArrayBuffer): boolean {
	if (buffer.byteLength < BINARY_HEADER_BYTES) return false;
	const view = new DataView(buffer);
	const declared = view.getUint32(80, true);
	return (
		buffer.byteLength === BINARY_HEADER_BYTES + declared * BINARY_TRIANGLE_BYTES
	);
}

/**
 * The normal stored in the file, or the one the winding implies. Exporters
 * routinely write (0,0,0) there, and a zero normal shades the whole face black.
 */
function faceNormal(
	stored: [number, number, number],
	ax: number,
	ay: number,
	az: number,
	bx: number,
	by: number,
	bz: number,
	cx: number,
	cy: number,
	cz: number,
): [number, number, number] {
	const [sx, sy, sz] = stored;
	const storedLen = Math.hypot(sx, sy, sz);
	if (storedLen > 1e-6 && Number.isFinite(storedLen)) {
		return [sx / storedLen, sy / storedLen, sz / storedLen];
	}
	const ux = bx - ax;
	const uy = by - ay;
	const uz = bz - az;
	const vx = cx - ax;
	const vy = cy - ay;
	const vz = cz - az;
	const nx = uy * vz - uz * vy;
	const ny = uz * vx - ux * vz;
	const nz = ux * vy - uy * vx;
	const len = Math.hypot(nx, ny, nz);
	// A degenerate triangle has no direction to point in; up is as good as any.
	if (len < 1e-12) return [0, 0, 1];
	return [nx / len, ny / len, nz / len];
}

function build(
	triangles: number[],
	storedNormals: number[],
	format: "binary" | "ascii",
): StlMesh {
	const triangleCount = triangles.length / 9;
	const positions = new Float32Array(triangles);
	const normals = new Float32Array(triangleCount * 9);
	const min: [number, number, number] = [
		Number.POSITIVE_INFINITY,
		Number.POSITIVE_INFINITY,
		Number.POSITIVE_INFINITY,
	];
	const max: [number, number, number] = [
		Number.NEGATIVE_INFINITY,
		Number.NEGATIVE_INFINITY,
		Number.NEGATIVE_INFINITY,
	];

	for (let t = 0; t < triangleCount; t++) {
		const p = t * 9;
		const [nx, ny, nz] = faceNormal(
			[
				storedNormals[t * 3] ?? 0,
				storedNormals[t * 3 + 1] ?? 0,
				storedNormals[t * 3 + 2] ?? 0,
			],
			positions[p] as number,
			positions[p + 1] as number,
			positions[p + 2] as number,
			positions[p + 3] as number,
			positions[p + 4] as number,
			positions[p + 5] as number,
			positions[p + 6] as number,
			positions[p + 7] as number,
			positions[p + 8] as number,
		);
		for (let v = 0; v < 3; v++) {
			normals[p + v * 3] = nx;
			normals[p + v * 3 + 1] = ny;
			normals[p + v * 3 + 2] = nz;
			for (let axis = 0; axis < 3; axis++) {
				const value = positions[p + v * 3 + axis] as number;
				if (value < (min[axis] as number)) min[axis] = value;
				if (value > (max[axis] as number)) max[axis] = value;
			}
		}
	}

	if (triangleCount === 0) {
		min[0] = min[1] = min[2] = 0;
		max[0] = max[1] = max[2] = 0;
	}

	return { positions, normals, triangleCount, min, max, format };
}

function parseBinary(buffer: ArrayBuffer): StlMesh {
	const view = new DataView(buffer);
	const count = view.getUint32(80, true);
	const triangles: number[] = new Array(count * 9);
	const storedNormals: number[] = new Array(count * 3);

	for (let t = 0; t < count; t++) {
		const base = BINARY_HEADER_BYTES + t * BINARY_TRIANGLE_BYTES;
		storedNormals[t * 3] = view.getFloat32(base, true);
		storedNormals[t * 3 + 1] = view.getFloat32(base + 4, true);
		storedNormals[t * 3 + 2] = view.getFloat32(base + 8, true);
		for (let v = 0; v < 9; v++) {
			triangles[t * 9 + v] = view.getFloat32(base + 12 + v * 4, true);
		}
	}

	return build(triangles, storedNormals, "binary");
}

function parseAscii(text: string): StlMesh {
	const tokens = text.split(/\s+/);
	const triangles: number[] = [];
	const storedNormals: number[] = [];
	const num = (i: number): number => {
		const value = Number.parseFloat(tokens[i] ?? "");
		return Number.isFinite(value) ? value : 0;
	};

	let i = 0;
	while (i < tokens.length) {
		if (tokens[i] !== "facet") {
			i++;
			continue;
		}
		let normal: [number, number, number] = [0, 0, 0];
		if (tokens[i + 1] === "normal") {
			normal = [num(i + 2), num(i + 3), num(i + 4)];
			i += 5;
		} else {
			i += 1;
		}

		const vertices: number[] = [];
		while (vertices.length < 9 && i < tokens.length) {
			const token = tokens[i];
			if (token === "vertex") {
				vertices.push(num(i + 1), num(i + 2), num(i + 3));
				i += 4;
			} else if (token === "endfacet" || token === "facet") {
				break;
			} else {
				i++;
			}
		}

		if (vertices.length === 9) {
			triangles.push(...vertices);
			storedNormals.push(...normal);
		}
	}

	return build(triangles, storedNormals, "ascii");
}

export function parseStl(buffer: ArrayBuffer): StlMesh {
	if (buffer.byteLength === 0) {
		throw new Error("Empty file");
	}
	if (isBinaryStl(buffer)) {
		return parseBinary(buffer);
	}
	const text = new TextDecoder().decode(buffer);
	if (!/\bfacet\b/.test(text)) {
		throw new Error("Not an STL file");
	}
	return parseAscii(text);
}

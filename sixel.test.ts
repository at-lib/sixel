import { encodeSixelImage } from './sixel';

process.stdout.write('\n\n');

for(let size = 1; size < 30; ++size) {
	const image = new Uint8Array(size * size);
	image.fill(0);

	for(let i = 0; i < size; ++i) {
		image[i] = 1;
		image[i * size] = 1;
		image[i * size + size - 1] = 2;
		image[(size - 1) * size + i] = 2;

		image[i * (size + 1)] = 3;
	}

	const palette: [number, number, number][] = [
		[0, 0, 0],
		[1, 1, 1],
		[0, 1, 0],
		[1, 0, 0]
	];

	encodeSixelImage({
		image,
		width: size,
		height: size,
		palette,
		transparentIndex: 0,
		write(chunk: Uint8Array) { process.stdout.write(chunk); }
	});

	process.stdout.write('\n');
}

process.stdout.write('\n');

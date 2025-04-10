// Fast sixel encoder for indexed color bitmap terminal graphics

// We split sixels into 32- and 16-bit integers. 64-bit integers would be better,
// but JavaScript doesn't support them. When porting to other languages,
// merge lo and hi parts into a single integer when possible.

/** Lowest bit set in all 4 bytes. */
const LSB_32 = 0x01010101;
/** Highest bit set in all 4 bytes. */
const MSB_32 = 0x80808080;
/** Lowest bit set in both bytes. */
const LSB_16 = 0x0101;
/** Highest bit set in both bytes. */
const MSB_16 = 0x8080;

/** Number of columns in lookahead buffer, maximum 7 to fit rows in bytes. */
const LOOKAHEAD = 7;
const LOOKAHEAD_BITS = (MSB_32 >>> (LOOKAHEAD - 1)) * ((1 << LOOKAHEAD) - 1);

/** Pack least significant bit from each byte to bits of a single byte.
  *
  * @param lo Flag bytes for top 4 pixels.
  * @param hi Flag bytes for bottom 2 pixels.
  *
  * @return 6-bit mask with a bit for each input byte. */

function packSixelPen(lo: number, hi: number): number {
	// .......f .......e =>
	// .......f ......fe
	hi |= hi >>> (8 - 1);

	// .......d .......c .......b .......a =>
	// .......d ......dc ......cb ......ba
	lo |= lo >>> (8 - 1);

	// .......d .......c .......b .......a =>
	// .......d ......dc .....dcb ....dcba
	lo |= lo >>> (16 - 2);

	// ..fedcba
	return (lo | hi << 4) & 63;
}

/** Encode a number as up to 3 ASCII digits, branchless.
  *
  * @param num Number to encode, integer between 0 - 999.
  * @param buffer Output buffer.
  * @param pos Target offset in output buffer.
  *
  * @return Offset one past the last written digit. */

function encodeNumber(num: number, buffer: Uint8Array, pos: number) {
	const hundreds = ~~(num / 100);
	buffer[pos] = 0x30 + hundreds;
	pos += +(hundreds != 0);
	num -= hundreds * 100;

	const tens = ~~(num / 10);
	buffer[pos] = 0x30 + tens;
	pos += +(hundreds + tens != 0);
	num -= tens * 10;

	buffer[pos++] = 0x30 + num;
	return pos;
}

/** Encode a 6-bit bitmap of vertically stacked pixels
  * stretched horizontally to given length, as
  * DEC terminal sixel control codes (printable ASCII).
  *
  * @param sixel Bitmap as a 6-bit integer.
  * @param runLength Repetitions (horizontal stretch in pixels).
  * @param buffer Output buffer.
  * @param pos Target offset in output buffer.
  *
  * @return Offset one past the last written character. */

export function encodeSixelRun(sixel: number, runLength: number, buffer: Uint8Array, pos: number): number {
	sixel += 0x3f;

	if(runLength > 3) {
		// DECGRI Graphics Repeat Introducer '!'.
		buffer[pos++] = 0x21;
		pos = encodeNumber(runLength, buffer, pos);
		buffer[pos++] = sixel;
		return pos;
	}

	// Always write 3 bytes to avoid branching, but advance output
	// pointer to keep only some and overwrite others soon.
	// An unaligned 32-bit write would be fine.
	buffer[pos] = sixel;
	buffer[pos + 1] = sixel;
	buffer[pos + 2] = sixel;
	return pos + runLength;
}

/** Clear pending flags for transparent pixels. */

function maskTransparentPixels(
	colBuffer: Uint32Array,
	width: number,
	transparentIndex: number,
	pendingLo: Uint32Array,
	pendingHi: Uint16Array
): void {
	const transparentPen = transparentIndex * LSB_32;
	let pos = 0;

	for(let x = 0; x < width; ++x) {
		// XOR with pen to make input bytes for transparent pixels equal zero.
		const lo = colBuffer[pos++] ^ transparentPen;
		const hi = colBuffer[pos++] ^ transparentPen;

		// Mask out pending pixel flag bytes where input bytes equal zero.
		pendingLo[x] &= ~(MSB_32 - (lo & ~MSB_32)) | lo;
		pendingHi[x] &= ~(MSB_16 - (hi & ~MSB_16)) | hi;
	}
}

interface PassState {
	gotPen: boolean;

	/** Pixels for a row of sixels in column-major order, 6 bytes for 6 pixels and 2 bytes of padding. */
	colBuffer: Uint32Array;
	/** Preallocated buffer for generating a single pass of sixel ASCII control codes. */
	passBuffer: Uint8Array;
	/** Preallocated buffer for byte-sized flags packed to 32 bits in column-major order,
	  * indicating pixels left to draw in top 4 pixel rows. */
	pendingLo: Uint32Array;
	/** Preallocated buffer for pixels left to draw in bottom 2 pixel rows. */
	pendingHi: Uint16Array;

	// Lookahead bitmap of future sixels to draw using the current pen.
	// Each byte represents a horizontal row of pixels, rightmost in the MSB. */
	/** Top 4 lookahead rows. */
	aheadLo: number;
	/** Bottom 2 lookahead rows. */
	aheadHi: number;

	/** Palette index of current drawing color repeated in each byte of a 32-bit integer. */
	penColor: number;
	/** Mask with a bit set for any row with missing pixels left after emitting latest pass of sixels. */
	pendingRowsMask: number;

	/** Number of identical output characters to write. */
	runLength: number;
	/** Latest sixel waiting to be written, once known how many times it gets repeated. */
	lastSixel: number;
}

function encodeSixelPass(outPos: number, x: number, width: number, state: PassState): number {
	let { colBuffer, passBuffer, pendingLo, pendingHi, aheadLo, aheadHi, penColor, pendingRowsMask, runLength, lastSixel } = state;
	let pos = x * 2;

	// Encode one pass of single-colored sixels.
	for(; x < width; ++x) {
		let maskLo = pendingLo[x];
		let maskHi = pendingHi[x];
		/** Mask of pixels left to draw in any color. */
		const pending = packSixelPen(maskLo >>> 7, maskHi >>> 7);

		// If there's pixels left to draw for this sixel,
		// but nothing in this color for this or a few future sixels,
		// then switch pen to color of topmost pixel still pending.
		if(pending && !state.gotPen) {
			state.gotPen = true;
			// Emit any sixels using previous color.
			outPos = encodeSixelRun(lastSixel, runLength, passBuffer, outPos);
			runLength = 0;

			/** Palette indices for top 4 pixels in this sixel. */
			let lo = colBuffer[pos];
			/** Palette indices for bottom 2 pixels in this sixel. */
			let hi = colBuffer[pos + 1];

			// Start with the top 4 pixels.
			let mask = maskLo;
			// Bit twiddling hack to clear all except the least significant set bit,
			// representing MSB of the byte corresponding to the topmost pending pixel.
			mask = mask & -mask;

			// Extract palette index from input byte matching the possible mask for top 4 pixels.
			// Divide to right-shift the byte with MSB set, making it the least significant byte.
			penColor = lo / ((mask >>> 7) || 0xffffffff) & 255;

			// If no pixel was missing among top 4, test the bottom 2 pixels.
			mask = maskHi & -!mask;
			mask = mask & -mask;

			// Extract palette index from bottom 2 pixels if the mask matches now.
			penColor += hi / ((mask >>> 7) || 0xffffffff) & 255;

			// Emit color change command.
			passBuffer[outPos++] = 0x23;
			outPos = encodeNumber(penColor, passBuffer, outPos);
			// Expand color index to all bytes.
			penColor *= LSB_32;

			// Update lookahead bitmap. Read LOOKAHEAD rows starting at current one.

			// Lo and hi contain palette indices of 6 pixels to match against pen.
			// XOR with pen to make matching bytes zero.
			lo ^= penColor;
			hi ^= penColor;

			// Bit twiddling hack to test each byte for zero in parallel:
			// - Set highest bit of all bytes to stop carry from propagating between them.
			// - Subtract lower bits to clear the carry if any bits are set.
			// - AND with original highest bits flipped, to clear carry if its bit was set.
			// Pending bytes matching pen become 0x80, others 0x00.
			aheadLo = (MSB_32 - (lo & ~MSB_32)) & ~lo & maskLo;
			aheadHi = (MSB_16 - (hi & ~MSB_16)) & ~hi & maskHi;
			let p = pos;

			for(let i = 1; i <= LOOKAHEAD; ++i) {
				p += 2;
				lo = colBuffer[p] ^ penColor;
				hi = colBuffer[p + 1] ^ penColor;

				// Keep shifting lookahead bytes right and setting the MSB when an input byte matches the pen.
				aheadLo = (aheadLo >>> 1) | ((MSB_32 - (lo & ~MSB_32)) & ~lo & pendingLo[x + i]);
				aheadHi = (aheadHi >>> 1) | ((MSB_16 - (hi & ~MSB_16)) & ~hi & pendingHi[x + i]);
			}
		} else {
			// Update lookahead bitmap. Read one row at offset LOOKAHEAD pixels ahead.
			const lo = colBuffer[pos + LOOKAHEAD * 2] ^ penColor;
			const hi = colBuffer[pos + LOOKAHEAD * 2 + 1] ^ penColor;

			// Right shift by 1, drop bits that crossed bytes, OR with MSB set for bytes matching pen.
			// Ignore pixels not marked pending.

			aheadLo = ((aheadLo >>> 1) & ~MSB_32) | ((MSB_32 - (lo & ~MSB_32)) & ~lo & pendingLo[x + LOOKAHEAD]);
			aheadHi = ((aheadHi >>> 1) & ~MSB_32) | ((MSB_16 - (hi & ~MSB_16)) & ~hi & pendingHi[x + LOOKAHEAD]);
		}

		// Clear pending flag bytes for pixels we're about to draw.
		maskLo &= ~(aheadLo << LOOKAHEAD);
		maskHi &= ~(aheadHi << LOOKAHEAD);
		pendingLo[x] = maskLo;
		pendingHi[x] = maskHi;

		// Set row-wide flags for pixels still missing afterwards
		// (we just need to know when nothing is left to draw).
		pendingRowsMask |= maskLo | maskHi;

		// MSBs of lookahead bytes contain bits for sixel at offset LOOKAHEAD pixels ahead.
		// Current sixel has been shifted that many bits right. Shift it the rest of the
		// way to LSB and pack those bits to a single byte.
		let sixel = packSixelPen(
			(aheadLo >>> (7 - LOOKAHEAD)) & LSB_32,
			(aheadHi >>> (7 - LOOKAHEAD)) & LSB_16
		);

		// We can repeat the previous sixel up to 255 times if and only if it has all the
		// wanted bits set, and won't draw over previous passes or transparent pixels.
		// Otherwise an exact match is not needed, we can fill pixels with a wrong color
		// if a future pass is known to fix them.
		// More optimal encoding could re-arrange colors to exploit this more.
		if((lastSixel & sixel) != sixel || (lastSixel & ~pending) || runLength >= 255) {
			// If we can't keep repeating previous sixels, emit them.
			outPos = encodeSixelRun(lastSixel, runLength, passBuffer, outPos);
			runLength = 0;
			lastSixel = sixel;
		}

		++runLength;
		pos += 2;
	}

	state.aheadLo = aheadLo;
	state.aheadHi = aheadHi;
	state.penColor = penColor;
	state.pendingRowsMask = pendingRowsMask;

	state.runLength = runLength;
	state.lastSixel = lastSixel;

	return outPos;
}

/** Encode a row 6 pixels tall as DEC terminal sixels.
  * Printable ASCII text, requires a header with control codes to print as graphics.
  *
  * Encode multiple passes of overlapping complete rows of sixels.
  * Each pass adds another color to most sixels still missing one.
  * We change drawing color ("pen") when the next sixel is missing
  * a color not matching the current pen color.
  * Sometimes sixels are skipped if the current color is needed again soon.
  *
  * @param width Image width in pixels / sixels.
  * @param height Row height, integer between 1 - 6.
  * @param row Number of sixel row to encode, mainly to check if it's the first or last row.
  * @param rows Total number of sixel rows this function will be called for.
  * @param transparentIndex Palette index of transparent color. Use -1 for no transparency.
  * @param write Callback to write a chunk of output bytes. */

function encodeSixelRow(
	width: number,
	height: number,
	row: number,
	rows: number,
	transparentIndex: number,
	state: PassState,
	write: (chunk: Uint8Array) => void
): void {
	const { colBuffer, passBuffer, pendingLo, pendingHi } = state;
	state.aheadLo = 0;
	state.aheadHi = 0;
	state.penColor = 0;

	// Mask out pixels past bottom of image.
	// Overflowing rows are marked with a zero bit and drawn transparent.
	pendingLo.fill(height < 4 ? ((1 << (height * 8)) - 1) & MSB_32 : MSB_32);
	pendingHi.fill(height > 4 ? ((1 << ((height - 4) * 8)) - 1) & MSB_16 : 0);

	if(transparentIndex >= 0) maskTransparentPixels(colBuffer, width, transparentIndex, pendingLo, pendingHi);

	/** Count number of passes over the same row of sixels. */
	let pass = 0;

	// Loop usually up to 6 times, adding a missing color to every sixel on a row.
	while(1) {
		let outPos = 0;
		state.pendingRowsMask = 0;
		state.runLength = 0;
		state.lastSixel = 0;
		state.gotPen = false;

		// Pretty-print an unnecessary line break.
		passBuffer[outPos++] = 0x0a;

		if(pass) {
			// Join passes with DECGCR Graphics Carriage Return '$'.
			passBuffer[outPos++] = 0x24;
		} else if(row) {
			// Join sixel rows with DECGNL Graphics Next Line '-'.
			passBuffer[outPos++] = 0x2d;
		}

		let beforeWrap = 0;
		if(width > LOOKAHEAD) {
			beforeWrap = width - LOOKAHEAD;
			outPos = encodeSixelPass(outPos, 0, beforeWrap, state);
		}

		// Make reads past the end of array "wrap around" by appending a copy of the first columns.
		for(let i = 0; i < LOOKAHEAD; ++i) {
			pendingLo[width + i] = pendingLo[i];
			pendingHi[width + i] = pendingHi[i];
		}

		outPos = encodeSixelPass(outPos, beforeWrap, width, state);

		// Emit final run of sixels for this pass. No need to encode zeroes at the end,
		// except on first pass of first row, due to some decoders getting the image width from it.
		if(state.runLength && (state.lastSixel || (!row && !pass))) {
			outPos = encodeSixelRun(state.lastSixel, state.runLength, passBuffer, outPos);
		}

		if(!state.pendingRowsMask && row == rows - 1) {
			// Exit sixel mode after last pass of last row.
			passBuffer[outPos++] = 0x1b;
			passBuffer[outPos++] = 0x5c;
		}

		// Allocate copy of control code string before re-using its buffer.
		write(passBuffer.slice(0, outPos));

		++pass;
		if(!state.pendingRowsMask) break;
	}
}

/** Transpose 6 rows of 256-color indexed image data into column-major order. */

function sixelTranspose(view: DataView, width: number, height: number, stride: number, offset: number, out: Uint32Array): void {
	let pos = offset;
	let end = pos + width;
	let q = 0;

	if(width >= 4 && height == 6) {
		let mask = 0;
		end -= 3;

		// Fast loop for reading 4 bytes from 6 rows each.
		while(pos < end) {
			let p = pos;

			// Read 4 columns of input.
			const w0 = view.getUint32(p, true); p += stride;
			const w1 = view.getUint32(p, true); p += stride;
			const w2 = view.getUint32(p, true); p += stride;
			const w3 = view.getUint32(p, true); p += stride;
			const w4 = view.getUint32(p, true); p += stride;
			const w5 = view.getUint32(p, true); p += stride;

			// Write 4 rows of output.
			mask = 0x000000ff; out[q++] = (w0 & mask) | ((w1 & mask) << 8) | ((w2 & mask) << 16) | (w3 << 24); out[q++] = (w4 & mask) | ((w5 & mask) << 8);
			mask = 0x0000ff00; out[q++] = ((w0 & mask) >>> 8) | (w1 & mask) | ((w2 & mask) << 8) | ((w3 & mask) << 16); out[q++] = ((w4 & mask) >>> 8) | (w5 & mask);
			mask = 0x00ff0000; out[q++] = ((w0 & mask) >>> 16) | ((w1 & mask) >>> 8) | (w2 & mask) | ((w3 & mask) << 8); out[q++] = ((w4 & mask) >>> 16) | ((w5 & mask) >>> 8);
			mask = 0xff000000; out[q++] = (w0 >>> 24) | ((w1 & mask) >>> 16) | ((w2 & mask) >>> 8) | (w3 & mask); out[q++] = (w4 >>> 24) | ((w5 & mask) >>> 16);

			pos += 4;
		}

		end += 3;
	}

	const chunkSize = stride * (height - 1);

	// Slow simple loop for reading less than 4 bytes and / or from less than 6 rows.
	for(; pos < end; ++pos) {
		let p = pos + chunkSize;
		let n = 0;

		while(p >= pos) {
			n = n * 256 + view.getUint8(p);
			p -= stride;
		}

		out[q++] = n >>> 0;
		out[q++] = (n / 0x100000000) >>> 0;
	}
}

export function encodeSixelHeader(
	width: number,
	height: number,
	palette: [number, number, number][],
	write: (chunk: Uint8Array) => void
) {
	const ps = (
		// DCS Device Control String introducer, Sixel Graphics Protocol Selector 'q'.
		'\x1bP0;1;q' +
		// DECGRA Set Raster Attributes '"'.
		'"1;1;'
	);

	const buffer = new Uint8Array(
		ps.length +
		// wwwww;hhhhh
		11 +
		// #nnn;2;rrr;ggg;bbb
		palette.length * 18
	);

	let pos = new TextEncoder().encodeInto(ps + width + ';' + height, buffer).written;

	// Emit RGB palette with channels scaled to integers 0-100.
	for(let num = 0; num < palette.length; ++num) {
		// DECGCI Graphics Color Introducer '#'.
		buffer[pos++] = 0x23;
		pos = encodeNumber(num, buffer, pos);
		buffer[pos++] = 0x3b;

		// '2' for RGB color.
		buffer[pos++] = 0x32;

		for(let i = 0; i < 3; ++i) {
			buffer[pos++] = 0x3b;
			pos = encodeNumber(~~(palette[num][i] * 100 + 0.5), buffer, pos);
		}
	}

	write(buffer.slice(0, pos));
}

/** Configuration for generating a Sixel image. */

export interface SixelImageConfig {
	/** Contiguous image buffer, one byte per pixel. */
	image: Uint8Array;

	/** Image width in pixels, unsigned 16-bit integer. */
	width: number;

	/** Image height in pixels, unsigned 16-bit integer. */
	height: number;

	/* RGB values 0-1 for every palette index used in image data. */
	palette: [number, number, number][];

	/* Palette index of transparent color. Use -1 for no transparency. */
	transparentIndex: number;

	/** Callback to write a chunk of output bytes.
	  * It should make a copy as needed, the same chunk buffer is re-used between calls. */
	write: (chunk: Uint8Array) => void;

	/** Distance in memory between vertically adjacent pixels
	  * (default is image width in pixels). */
	stride?: number;

	/* Byte offset to start of image data (default 0). */
	offset?: number;
}

/** Encode an indexed 256-color image stored as one-byte pixels,
  * into a string of DEC terminal control codes to render it using sixels.
  *
  * @param config Configuration object. */

export function encodeSixelImage(config: SixelImageConfig): void {
	// Enforce sensible limits.
	const width = (config.width & 0xffff) || 1;
	const height = (config.height & 0xffff) || 1;
	const transparentIndex = config.transparentIndex < 0 ? -1 : (config.transparentIndex & 0xff) || 0;
	const image = config.image;
	const write = config.write;
	const stride = config.stride || width;
	let offset = config.offset || 0;

	encodeSixelHeader(width, height, config.palette, write);

	/** View for un-aligned reads from image data. */
	const imageView = new DataView(image.buffer, image.byteOffset);

	/** Number of sixel rows needed to cover image. */
	const rows = ~~((height + 5) / 6);
	/** Size of input buffer chunk that fits into a row of sixels. */
	const chunkSize = stride * 6;

	const state = {
		colBuffer: new Uint32Array((width + LOOKAHEAD) * 2),

		// Theoretical worst case maximum ASCII characters to encode one pass of a sixel row of noise is
		// 5 bytes per sixel ("#nnn" to change color, 1 byte of image data),
		// plus 2 bytes for end of line character and optional line break for pretty printing
		// plus 3 bytes for safely writing 4 bytes with 3 overflowing output string (also used by 2 bytes for terminator).
		passBuffer: new Uint8Array(width * 5 + 5),

		pendingLo: new Uint32Array(width + LOOKAHEAD),
		pendingHi: new Uint16Array(width + LOOKAHEAD)
	} as PassState;

	const { colBuffer } = state;

	for(let row = 0; row < rows; ++row) {
		let rowHeight = height - row * 6;
		if(rowHeight > 6) rowHeight = 6;

		sixelTranspose(imageView, width, rowHeight, stride, offset, colBuffer);

		// Make reads past the end of array "wrap around" by appending a copy of the first columns.
		let src = 0;
		let dst = width * 2;
		while(src < LOOKAHEAD * 2) colBuffer[dst++] = colBuffer[src++];

		encodeSixelRow(width, rowHeight, row, rows, transparentIndex, state, write);

		offset += chunkSize;
	}
}

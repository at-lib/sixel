# `@lib/sixel`

[![npm version](https://badgen.net/npm/v/@lib/sixel)](https://www.npmjs.com/package/@lib/sixel)

Draw indexed color bitmap graphics on terminals supporting sixel graphics.

![Screenshot](doc/terminal.svg)

Install:

```bash
npm install --save @lib/sixel
```

## API

***ƒ*** `encodeSixelImage(config: SixelImageConfig): void`

Encode an indexed 256-color image stored as one-byte pixels,
into a string of DEC terminal control codes to render it using sixels.

- `config` Configuration object.
- Returns: String of DEC terminal control codes.

## Example

Create a file `mandelbrot.ts`:

```TypeScript
import { encodeSixelImage } from '@lib/sixel';

const size = 257;
const image = new Uint8Array(size * size);
const step = 4 / (size - 1);
let pos = 0;

for(let b = 2; b >= -2; b -= step) {
    for(let a = -2; a <= 2; a += step) {
        let p = 0, q = 0, i = 0;

        while(i++ < 16 && p * p + q * q < 4) {
            const t = p * p - q * q + a;
            q = 2 * p * q + b;
            p = t;
        }

        image[pos++] = i & 1;
    }
}

encodeSixelImage({
    image,
    width: size,
    height: size,
    palette: [[0, 0, 0], [1, 1, 1]],
    transparentIndex: -1,
    write(chunk: Uint8Array) { process.stdout.write(chunk); }
});

process.stdout.write('\n');

// This is how to output a PGM image instead:
// process.stdout.write('P5 ' + size + ' ' + size + ' 1\n');
// process.stdout.write(image);
```

Run it:

```bash
npx @lib/run mandelbrot
```

It should literally output a fractal image like at the top of this readme.

# License

0BSD, which means use as you wish and no need to mention this project or its author. Consider it public domain in practice.

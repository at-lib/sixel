# `@lib/sixel`

Draw indexed color bitmap graphics on terminals supporting sixel graphics.

Install:

```bash
npm install --save @lib/sixel
```

Now create a file `mandelbrot.ts`:

```TypeScript
import { encodeSixelImage } from './sixel';

const size = 257;
const image = new Uint8Array(size * size);
let pos = 0;

for(let b = 2; b >= -2; b -= 4 / (size - 1)) {
    for(let a = -2; a <= 2; a += 4 / (size - 1)) {
        let p = 0;
        let q = 0;
        let i = 0;

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

It should print (literally this image in the terminal window):

![Fractal](doc/mandelbrot.png)

# License

0BSD, which means use as you wish and no need to mention this project or its author. Consider it public domain in practice.

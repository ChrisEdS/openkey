# openkey

Read the musical key, Open Key code, tempo, and energy of an MP3, then write the fields you choose back into the file. The audio is not re-encoded.

![openkey with key, Open Key, BPM, and energy for five tracks](docs/screenshot.png)

## Run

```bash
npm install
npm run dev
```

Open the address Vite prints in Chrome or Edge. Drop MP3s on the page, or choose them. The track list scrolls on its own, and the status filters stay in view.

Safari can display a result, but it cannot overwrite the original file.

## What gets saved

Energy is selected by default. Key, Open Key, and BPM stay off, so those tags are left alone until you turn them on.

| Choice | Written tag |
| --- | --- |
| Energy | `TXXX` description `EnergyLevel`, value `1`–`10`, plus a comment token `Energy N` |
| Key | `TKEY`, for example `Am` or `F#` |
| Open Key | `TKEY`, for example `8A` |
| Key and Open Key together | `TKEY` keeps the Open Key code. `TXXX` description `MusicalKey` keeps the musical name |
| BPM | `TBPM`, the same number shown in the table, including one decimal |

Artwork, DJ markers, and every other frame are copied through. ID3v2.2 files are refused. The same file always gets the same energy integer.

The first save asks once for the folder that contains the tracks. Chrome can then update every MP3 in that folder. It does not ask again for each file.

## Energy

The score runs from 1 to 10 and is tuned for electronic music. It uses Essentia’s onset rate, danceability, and loudness movement, plus how much of the signal sits above 5 kHz. A steady club track lands around 7. A sparser groove lands around 4.

Open Key follows the Camelot wheel: A minor is 8A, and C major is 8B. “Mixes with” is the previous, next, and relative code.

## Develop

```bash
npm test
npm run lint
```

essentia.js is AGPL-3.0. That license applies if this app is distributed.

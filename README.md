# openkey

Read the musical key, Open Key code, tempo, energy, brightness, and shape of an MP3. Write the fields you choose back into the file. The audio is not re-encoded.

![openkey with key, energy, brightness, and shape for a few tracks](docs/screenshot.png)

## Run

```bash
npm install
npm run dev
```

Open the address Vite prints in Chrome or Edge. Drop MP3s on the page, or choose them. The track list scrolls on its own. Status filters, retry, and clear stay in view.

Safari can show a result, but it cannot overwrite the original file.

## What you see

Each track gets a row once analysis finishes.

| Column | Meaning |
| --- | --- |
| Key | Musical key, for example A minor. A low-confidence result is marked. |
| Open Key | Camelot code. A minor is 8A, and C major is 8B. |
| BPM | Tempo to one decimal. |
| Energy | 1–10. A steady club track lands around 7. A sparser groove lands around 4. |
| Brightness | Share of the signal above 5 kHz, from 0 to 1. |
| Shape | How the drive changes through the track. L stays level, B builds, and D jumps between quiet and peak. |
| Mixes with | The previous, next, and relative Open Key code. |

Brightness and shape stay in the table. They are not written into the file.

## What gets saved

Energy is on by default and is written to the energy tag (`EnergyLevel`). Comment sits under Energy. With both on, the comment also receives the Open Key and the energy in the form Mixed In Key uses, `8A - Energy 7`, placed in front of any note that is already there.

Turning Comment off keeps the energy tag and leaves the comment alone. Turning Energy off writes neither, and leaves the comment alone. Key, Open Key, and BPM stay off, so those tags are left alone until you turn them on.

| Choice | Written tag |
| --- | --- |
| Energy | `TXXX` description `EnergyLevel`, value `1`–`10` |
| Key | `TKEY`, for example `Am` or `F#` |
| Open Key | `TKEY`, for example `8A` |
| Key and Open Key together | `TKEY` keeps the Open Key code. `TXXX` description `MusicalKey` keeps the musical name |
| BPM | `TBPM`, the same number shown in the table, including one decimal |
| Comment | With Energy on, `8A - Energy 7` in front of the existing comment |

An older `Energy 5` or `11A - Energy 4` in that comment is replaced, not stacked. Artwork, DJ markers, and every other frame are copied through. ID3v2.2 files are refused. The same file always gets the same energy integer. A file that was tagged before keeps those values until you analyze it again and write.

The first save asks once for the folder that contains the tracks. Chrome can then update every MP3 in that folder. It does not ask again for each file.

## How the numbers are made

Energy uses Essentia’s onset rate, danceability, and loudness movement, plus how much of the signal sits above 5 kHz. It is tuned for electronic music. Brightness is that high-frequency share on its own. Shape compares onset density at the start, the build, the middle, and the end.

## Develop

```bash
npm test
npm run lint
```

essentia.js is AGPL-3.0. That license applies if this app is distributed.

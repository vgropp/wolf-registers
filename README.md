# Wolf eBUS register generator

Generate an [ebusd](https://ebusd.eu/) CSV configuration from register metadata
published by Wolf in the
[`zivillian/ism7mqtt`](https://github.com/zivillian/ism7mqtt) project. Heavaly 
based on the work by DragoSavov in this [discussion](https://github.com/john30/ebusd/discussions/779#discussioncomment-18666323).

Wolf devices expose many useful heating-system values over eBUS, but their
register documentation and ready-to-use ebusd configurations can be difficult
to find. This tool looks up the parameters for the Wolf device templates you
select and generates read rows, plus optional write rows, with the message IDs
and data types ebusd needs.

The project’s technical background, checksum derivation, write details, and
field notes by DragoSavov are preserved in [HISTORY.md](./HISTORY.md).

## Requirements

- Node.js (no npm packages are required)
- An internet connection on the first run, to download Wolf’s XML metadata

The XML files are cached alongside the script after download.

## Quick start

List the available device templates:

```sh
node wolf-registers.js --list
```

Find the template for your device, then generate a CSV for it:

```sh
node wolf-registers.js --device FGB --csv > fgb.csv
```

To include writable parameters where the metadata supports them:

```sh
node wolf-registers.js --device FGB --csv --write > fgb.csv
```

The generated file is a starting point for your ebusd configuration. Review it
and validate it with ebusd before installing or using it. In particular, take
care when enabling writes: a generated write row makes a parameter writable,
but it does not determine whether changing that value is appropriate for your
heating system.

## Generate a combined configuration

Pass a comma-separated list of template names to generate one CSV for multiple
devices:

```sh
node wolf-registers.js --device DHK_BM-2,MK_BM-2,WW_BM-2,WWSystem_BM-2,MM,ISM,CHA,BM-2 --csv --write > wolf-all.csv
```

Names are matched case-insensitively against the templates shown by `--list`.
The CSV contains rows from each selected template. Rows with the same eBUS
message signature are emitted only once, so shared registers do not produce
duplicate message definitions. Register names are made unique within their
generated class.

Generated ebusd names cannot begin with a number. The generator moves a
numeric-leading first segment to the end of the name: for example,
`1x Warmwasser` becomes `warmwasser_1x`, and `2 Warmwasser` becomes
`warmwasser_2`. The segment is the text before the first underscore, so this
rule applies to any numeric-leading token, not just multipliers. A
numeric-leading name without a following segment receives a `num_` prefix.
Regenerate existing CSV files to apply the updated naming.

You can omit `--write` to generate read rows only. Without `--csv`, the script
does not generate a register listing; use `--csv` to request ebusd output.

## Identifying your template

Run `node wolf-registers.js --list` and compare the `WRSDeviceIds` values with
your device's eBUS scan information. For example, a scan may show an ID such as
`" &"`; those characters represent bytes `0x20 0x26`, and `0x26` matches the
`WRSDeviceIds` value for the `FGB` template. The detailed matching example and
background are in [HISTORY.md](./HISTORY.md).

## What the generator does

The script downloads Wolf's `parameter.xml`, `converter.xml`, and `device.xml`
metadata, joins device parameters to their converter definitions, and maps
supported Wolf types to ebusd types. Read IDs use the checksum implemented by
the script; write IDs use the separate, unchecked write format described in
[HISTORY.md](./HISTORY.md).

Not every metadata entry can be emitted: unsupported data types and bitfields
are skipped. Generated rows should be checked against your device and ebusd
version before use.

## Project history

See [HISTORY.md](./HISTORY.md) for the original technical write-up, checksum
investigation, write examples, and troubleshooting notes.

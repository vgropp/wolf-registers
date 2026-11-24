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
The CSV contains rows from the selected templates. A register is identified by
its destination address, read ID, type, divider and unit:

- The same register at the same address is emitted only once. If a later
  template is skipped this way, a summary on stderr says how many entries were
  skipped and suggests `--address`. Example: `DHK_BM-2,MK_BM-2` without
  `--address` gives only the `dhk` class, because both templates share their
  registers at `08`.
- Metadata variants share an ID but use a different type, divider or unit. For
  example, TelegramNr 410 is listed as `PRELOAD_Firmware` (UIN) and as
  `Firmware` (SIN/100), and the MM input E1 is listed as a digital value and as
  a temperature. ebusd accepts only one definition per address and ID
  (otherwise it stops loading with `ERR: duplicate entry, duplicate ID`), so
  the first definition is active and every further variant is emitted
  commented out (`#r5,...`) and listed on stderr. If a variant matches your
  device better, comment out the active row and uncomment the variant.

Register names are made unique within their generated class. A single selected template uses the
`heating` class by default; combined output derives a class from each template
name. Use `--class <name>` to override the class (for example,
`--device FGB --class heating --csv`).

Read rows target address `08` by default. If you have confirmed the eBUS
address for each selected template, map templates to addresses with
`--address`:

```sh
node wolf-registers.js --device DHK_BM-2,MK_BM-2 --address DHK_BM-2=08,MK_BM-2=85 --csv > wolf-test.csv
```

Only use addresses verified for your installation; the template metadata does
not provide this mapping. The address must be a slave address: master
addresses and the reserved values `a9`, `aa` and `fe` are rejected.

Write rows go to the master address that belongs to the read address. On eBUS
this is the read address minus 5, for example `08` -> `03` or `35` -> `30`.
Only `08` -> `03` has been verified (see [HISTORY.md](./HISTORY.md)). Treat
writes to other addresses as untested; the generator prints a warning for
them. If the read address does not belong to a master (for example `50` or
`51` for an MM), the generator emits no write rows for that template and
reports this on stderr.

Generated ebusd names cannot begin with a number. The generator moves a
numeric-leading first segment to the end of the name: for example,
`1x Warmwasser` becomes `warmwasser_1x`, and `2 Warmwasser` becomes
`warmwasser_2`. If the resulting name still starts with a number, it receives
a `num_` prefix (for example, `0 - 10 V GLT` becomes
`num_10_v_glt_0`). Regenerate existing CSV files to apply the updated naming.

You can omit `--write` to generate read rows only. Without `--csv`, the script
prints a register listing, including value lists and parameters without a
TelegramNr. Use `--csv` to request ebusd output.

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
are skipped in CSV output; the non-CSV register listing includes bitfields and
parameters without a TelegramNr for reference. Generated rows should be
checked against your device and ebusd version before use. The CSV header
documents each selected template's DTID and WRSDeviceIds, plus the read-ID
checksum and write format.

## Project history

See [HISTORY.md](./HISTORY.md) for the original technical write-up, checksum
investigation, write examples, and troubleshooting notes.

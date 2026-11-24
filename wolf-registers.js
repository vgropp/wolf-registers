#!/usr/bin/env node
/*
 * wolf-registers.js — generate an ebusd CSV for ANY Wolf heating device
 * =====================================================================
 *
 * Wolf publishes no eBUS documentation, so every ebusd config for their kit is
 * hand-made and partial. But Wolf's own SmartSet/ISM7 metadata IS public, inside
 * the zivillian/ism7mqtt project, and it lists every parameter of every device
 * with its TelegramNr, data type, unit, range and value labels.
 *
 * The only thing standing between that list and a working ebusd config was the
 * checksum byte in the read telegram. That is solved (see wolfCrc below), so
 * this script can turn Wolf's metadata straight into CSV.
 *
 * USAGE
 *   node wolf-registers.js --list                 list every Wolf device template
 *   node wolf-registers.js --device DHK_BM-2,MK_BM-2,WW_BM-2,WWSystem_BM-2,MM,ISM,CHA,BM-2            dump those devices' registers
 *   node wolf-registers.js --device DHK_BM-2,MK_BM-2,WW_BM-2,WWSystem_BM-2,MM,ISM,CHA,BM-2  --csv     emit ebusd CSV rows
 *   node wolf-registers.js --device DHK_BM-2,MK_BM-2,WW_BM-2,WWSystem_BM-2,MM,ISM,CHA,BM-2  --csv --write   also emit write rows
 *   docker run --rm -v $(pwd):/app -w /app node:latest node wolf-registers.js --device DHK_BM-2,MK_BM-2,WW_BM-2,WWSystem_BM-2,MM,ISM,CHA,BM-2 --csv --write > wolf-all.csv
 *
 * It downloads three files (~5 MB) on first run and caches them next to itself.
 *
 * Which device are you? Run `ebusctl info` and look at the scanned slave string,
 * e.g.  MF=65;ID=" &";SW=0029;HW=0001 .  ebusd cannot decode Wolf's manufacturer
 * id, and the ID looks like garbage - but those ID bytes are hex. " &" is
 * 0x20 0x26, and 0x26 is exactly the WRSDeviceIds value of the "FGB" template.
 * --list prints WRSDeviceIds for every device so you can match yours.
 *
 * Licence: The Unlicense
 */

'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');

const BASE = 'https://raw.githubusercontent.com/zivillian/ism7mqtt/master/src/ism7mqtt/Resources';
const FILES = ['parameter.xml', 'converter.xml', 'device.xml'];
const CACHE = __dirname;

/* ------------------------------------------------------------------ *
 * THE CHECKSUM
 *
 * A Wolf read telegram is:   ZZ=08  PB SB = 50 22  NN = 03  <CS> <lo> <hi>
 * where <lo><hi> is the TelegramNr little-endian and <CS> is this byte.
 *
 * It is linear over GF(2), which is what makes it solvable from known-good
 * IDs: take the pairs out of any working Wolf 08.csv, treat each output bit
 * as a linear equation over the 16 index bits plus a constant, and solve.
 * Doing that on 22 verified pairs gives bit-effects that are exactly a
 * CRC8 chain with polynomial 0x5c over the LOW byte, with the HIGH byte
 * XORed in afterwards and never shifted:
 * ------------------------------------------------------------------ */
function wolfCrc(telegramNr) {
    let c = telegramNr & 0xff;
    for (let i = 0; i < 8; i++) c = (c & 0x80) ? (((c << 1) & 0xff) ^ 0x5c) : ((c << 1) & 0xff);
    return (c ^ (telegramNr >> 8)) & 0xff;
}
const hx = n => n.toString(16).padStart(2, '0');

/* eBUS master addresses have both nibbles in {0,1,3,7,f}; a master's slave address is master + 5. */
const MASTER_NIBBLES = [0x0, 0x1, 0x3, 0x7, 0xf];
const isMaster = a => MASTER_NIBBLES.includes(a >> 4) && MASTER_NIBBLES.includes(a & 0xf);
/** Write destination for a read address: the master behind that slave address, or null if there is none. */
function writeAddressFor(readAddress) {
    const a = parseInt(readAddress, 16);
    if (a < 0x06) return null;
    const master = a - 5;
    return isMaster(master) ? hx(master) : null;
}
/** Read rows must target a slave: not a master address, not SYN (aa), escape (a9) or broadcast (fe). */
const isValidReadAddress = a => !isMaster(a) && ![0xa9, 0xaa, 0xfe].includes(a);

/** Read message ID: <checksum><TelegramNr little-endian> */
const readId  = tn => hx(wolfCrc(tn)) + hx(tn & 0xff) + hx((tn >> 8) & 0xff);
/** Write message ID: 00<TelegramNr little-endian> — writes are NOT checksummed */
const writeId = tn => '00' + hx(tn & 0xff) + hx((tn >> 8) & 0xff);

/* Wolf converter type -> [ebusd base type, divider] */
const TYPES = {
    SS   : ['SIN', ''],    SS10 : ['SIN', 10],   SS100: ['SIN', 100],
    US   : ['UIN', ''],    US10 : ['UIN', 10],   US100: ['UIN', 100],
    UINT32: ['UIN', ''],   // these come back as 16-bit on the devices tested
};

function get(url, dest) {
    return new Promise((resolve, reject) => {
        https.get(url, res => {
            if (res.statusCode !== 200) return reject(new Error(url + ' -> HTTP ' + res.statusCode));
            const out = fs.createWriteStream(dest);
            res.pipe(out);
            out.on('finish', () => out.close(resolve));
        }).on('error', reject);
    });
}

async function ensureFiles() {
    for (const f of FILES) {
        const p = path.join(CACHE, f);
        if (fs.existsSync(p) && fs.statSync(p).size > 10000) continue;
        process.stderr.write('downloading ' + f + ' ...');
        await get(BASE + '/' + f, p);
        process.stderr.write(' ' + fs.statSync(p).size + ' bytes\n');
    }
}

function load() {
    const read = f => fs.readFileSync(path.join(CACHE, f), 'utf8');
    const dev = read('device.xml'), conv = read('converter.xml'), par = read('parameter.xml');

    // CTID -> {telegramNr, type, bitnumber}
    const C = {};
    for (const m of conv.matchAll(/<(\w+Template) CTID="(\d+)">([\s\S]*?)<\/\1>/g)) {
        const id = +m[2]; if (C[id]) continue;
        const b = m[3], g = t => { const r = b.match(new RegExp('<' + t + '>([^<]*)</' + t + '>')); return r ? r[1] : null; };
        C[id] = { tag: m[1], tn: g('TelegramNr'), type: g('Type'), bit: g('Bitnumber') };
    }
    // PTID -> descriptor
    const P = {};
    for (const m of par.matchAll(/<(\w*ParameterDescriptor) PTID="(\d+)">([\s\S]*?)<\/\1>/g)) {
        const id = +m[2], b = m[3];
        const g = t => { const r = b.match(new RegExp('<' + t + '>([^<]*)</' + t + '>')); return r ? r[1] : ''; };
        P[id] = { name: g('Name'), unit: g('UnitName'), min: g('MinValueCondition'),
                  max: g('MaxValueCondition'), ctrl: g('ControlType'), kvl: g('KeyValueList') };
    }
    // devices
    const D = [];
    const blocks = dev.split('<DeviceTemplate ').slice(1);
    for (const blk of blocks) {
        const head = blk.match(/DTID="(\d+)" Name="([^"]*)"/);
        if (!head) continue;
        const wrs = (blk.match(/<WRSDeviceIds>([^<]*)<\/WRSDeviceIds>/) || [, ''])[1];
        const ptids = [...blk.matchAll(/<ParameterReference PTID="(\d+)"/g)].map(x => +x[1]);
        D.push({ dtid: +head[1], name: head[2], wrs, ptids });
    }
    return { C, P, D };
}

function rows(device, C, P) {
    const out = [];
    for (const id of device.ptids) {
        const c = C[id], p = P[id];
        if (!c || !p) continue;
        out.push({ ptid: id, tn: c.tn === null ? null : +c.tn, wolfType: c.type, bit: c.bit,
                   tag: c.tag, name: p.name, unit: p.unit, min: p.min, max: p.max,
                   ctrl: p.ctrl, kvl: p.kvl });
    }
    return out.sort((a, b) => (a.tn ?? 1e9) - (b.tn ?? 1e9));
}

const slug = s => (s || '')
    .replace(/[äÄ]/g, 'ae').replace(/[öÖ]/g, 'oe').replace(/[üÜ]/g, 'ue').replace(/ß/g, 'ss')
    .replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').toLowerCase().slice(0, 40) || 'unnamed';

/** Text for a CSV field: no separators, quotes or line breaks. */
const csvText = s => (s || '').replace(/[\r\n,";]/g, ' ').trim();

function main() {
    const argv = process.argv.slice(2);
    const want = (f) => {
        const i = argv.indexOf(f);
        if (i < 0) return null;
        const v = argv[i + 1];
        if (v === undefined || v.startsWith('--')) { console.error(`Option ${f} needs a value.`); process.exit(1); }
        return v;
    };
    const has  = (f) => argv.includes(f);

    const { C, P, D } = load();

    if (has('--list') || (!want('--device'))) {
        console.log('Wolf device templates (match WRSDeviceIds against your ebusd scan ID bytes):\n');
        console.log('  DTID    WRSDeviceIds  params  Name');
        D.sort((a, b) => a.name.localeCompare(b.name)).forEach(d =>
            console.log('  ' + String(d.dtid).padEnd(8) + String(d.wrs).padEnd(14) +
                        String(d.ptids.length).padEnd(8) + d.name));
        console.log('\nThen: node wolf-registers.js --device <Name>,<Name2> [--address <Name>=<ZZ>,<Name2>=<ZZ>] [--class <name>] [--csv] [--write]');
        return;
    }

    // allow comma seperated list (z.B. --device DHK_BM-2,MK_BM-2,WW_BM-2)
    const deviceNames = want('--device').split(',').map(s => s.trim());
    const targetDevices = [];

    for (const name of deviceNames) {
        const device = D.find(d => d.name.toLowerCase() === name.toLowerCase());
        if (!device) { console.error(`Device not found: ${name} (try --list)`); process.exit(1); }
        targetDevices.push({ template: device, reqName: name });
    }

    const addresses = new Map();
    const addressOption = want('--address');
    if (addressOption) {
        for (const mapping of addressOption.split(',')) {
            const separator = mapping.indexOf('=');
            if (separator < 1 || separator !== mapping.lastIndexOf('=')) {
                console.error(`Invalid address mapping "${mapping}"; expected Template=ZZ.`);
                process.exit(1);
            }
            const templateName = mapping.slice(0, separator).trim().toLowerCase();
            const address = mapping.slice(separator + 1).trim();
            if (!/^[0-9a-f]{2}$/i.test(address)) {
                console.error(`Invalid eBUS address "${address}" for ${mapping.slice(0, separator)}; expected two hex digits.`);
                process.exit(1);
            }
            if (!isValidReadAddress(parseInt(address, 16))) {
                console.error(`Invalid eBUS address "${address}" for ${mapping.slice(0, separator)}; expected a slave address (not a master, a9, aa or fe).`);
                process.exit(1);
            }
            if (addresses.has(templateName)) {
                console.error(`Duplicate address mapping for ${mapping.slice(0, separator)}.`);
                process.exit(1);
            }
            const selectedDevice = targetDevices.find(dev => dev.template.name.toLowerCase() === templateName);
            if (!selectedDevice) {
                console.error(`Address mapping "${mapping}" does not match a selected device template.`);
                process.exit(1);
            }
            addresses.set(templateName, address.toLowerCase());
        }
    }

    for (const dev of targetDevices) {
        dev.address = addresses.get(dev.template.name.toLowerCase()) || '08';
    }

    const csv = has('--csv');
    if (!csv) {
        for (const dev of targetDevices) {
            const R = rows(dev.template, C, P);
            console.log(`# ${dev.template.name}  (DTID ${dev.template.dtid}, WRSDeviceIds ${dev.template.wrs}) — ${R.length} parameters\n`);
            console.log('TelegramNr  readID   writeID  Type    Unit   Range        Name');
            console.log('-'.repeat(100));
            for (const r of R) {
                if (r.tn === null) { console.log('    (none)                              ' + r.name); continue; }
                const range = (r.min !== '' || r.max !== '') ? r.min + '..' + r.max : '';
                console.log(String(r.tn).padEnd(11) + readId(r.tn).padEnd(9) + writeId(r.tn).padEnd(9) +
                            String(r.wolfType).padEnd(8) + String(r.unit).padEnd(7) +
                            range.padEnd(13) + r.name + (r.bit !== null ? '   [bit ' + r.bit + ']' : ''));
            }
            const valueLists = R.filter(r => r.kvl);
            if (valueLists.length) {
                console.log('\nValue lists:');
                valueLists.forEach(r => console.log('  ' + r.tn + ' ' + r.name + ': ' + r.kvl));
            }
            console.log('');
        }
        return;
    }

    // ---- CSV output ----
    console.log('# type,class,name,comment,QQ,ZZ,PBSB,ID,field,part,type,divider,unit,comment');
    console.log(`# Generated by wolf-registers.js for: ${deviceNames.join(', ')}`);
    for (const dev of targetDevices) {
        console.log(`# ${dev.template.name} (DTID ${dev.template.dtid}, WRSDeviceIds ${dev.template.wrs}, read address ${dev.address})`);
    }
    console.log('# read  ID = <crc8 poly 0x5c over low byte, XOR high byte><TelegramNr LE>');
    console.log('# write ID = 00<TelegramNr LE>, plus a 4-byte suffix 9d010000');
    console.log('# write address = master address of the read address (read address - 5); verified only for 08 -> 03');

    const seenReadIds = new Map();
    const warnedReadDuplicates = new Set();
    const seenWriteIds = new Set();
    const variantsEmitted = [];
    let readRowsEmitted = 0;
    const seenNamesPerClass = new Map();
    const classOverride = want('--class');

    for (const dev of targetDevices) {
        const R = rows(dev.template, C, P);

        const cls = classOverride
            ? slug(classOverride)
            : targetDevices.length === 1 ? 'heating' : slug(dev.reqName.split('_')[0]);

        if (!seenNamesPerClass.has(cls)) seenNamesPerClass.set(cls, new Set());

        const writeAddress = writeAddressFor(dev.address);
        if (has('--write') && !writeAddress) {
            console.error(`# No write rows for ${dev.reqName}: read address ${dev.address} is not the slave address of an eBUS master.`);
        } else if (has('--write') && writeAddress !== '03') {
            console.error(`# Warning: write rows for ${dev.reqName} go to ${writeAddress}; only 03 has been verified. Test on a harmless register first.`);
        }
        let skippedShared = 0;

        for (const r of R) {
            if (r.tn === null || r.bit !== null) continue; // bitfields need hand-shaping
            const t = TYPES[r.wolfType]; if (!t) continue;

            let n = slug(r.name);
            const numericPrefix = n.match(/^([0-9][^_]*)_(.+)$/);
            if (numericPrefix) {
                n = `${numericPrefix[2]}_${numericPrefix[1]}`;
            }
            if (/^[0-9]/.test(n)) {
                n = 'num_' + n;
            }

            const readIdStr = readId(r.tn);
            const readAddress = dev.address;
            // Same address and ID with the same decoding is the same register: emit it once.
            // A different type, divider or unit is a metadata variant (e.g. TelegramNr 410
            // PRELOAD_Firmware UIN vs Firmware SIN/100). ebusd rejects a second message with the
            // same ID ("duplicate ID"), so variants are emitted commented out for the user to swap in.
            const readKey = JSON.stringify([readAddress, readIdStr]);
            const decodeKey = JSON.stringify([t[0], t[1], r.unit || '']);
            if (!seenReadIds.has(readKey)) seenReadIds.set(readKey, new Map());
            const decodings = seenReadIds.get(readKey);
            const previousRead = decodings.get(decodeKey);
            if (previousRead) {
                if (previousRead.device.toLowerCase() !== dev.reqName.toLowerCase()) {
                    skippedShared++;
                    const warningKey = JSON.stringify([readKey, decodeKey, previousRead.device, dev.reqName]);
                    if (!warnedReadDuplicates.has(warningKey)) {
                        warnedReadDuplicates.add(warningKey);
                        console.error(
                            `# Skipping shared definition for read ID ${readIdStr} at ${readAddress} from ${dev.reqName} (${cls}); ` +
                            `already emitted from ${previousRead.device} (${previousRead.cls}).`
                        );
                    }
                }
                continue;
            }
            const isVariant = decodings.size > 0;
            decodings.set(decodeKey, { cls, device: dev.reqName });

            let finalN = n;
            let i = 2;
            const namesForClass = seenNamesPerClass.get(cls);
            while (namesForClass.has(finalN)) {
                finalN = n + '_' + (i++);
            }
            namesForClass.add(finalN);
            if (isVariant) variantsEmitted.push(`${cls},${finalN} (TelegramNr ${r.tn} at ${readAddress}, ${t[0]}${t[1] ? '/' + t[1] : ''})`);

            const cmt = csvText(r.name) + (r.min !== '' ? ` (${r.min}-${r.max})` : '');

            // ---- READ ROW ----
            const prefix = isVariant ? '#' : '';
            if (!isVariant) readRowsEmitted++;
            console.log(`${prefix}r5,${cls},${finalN},${cmt},,${readAddress},5022,${readIdStr},${finalN},,${t[0]},${t[1]},${csvText(r.unit)},TelegramNr ${r.tn}`);

            // ---- WRITE ROW ----
            if (has('--write') && writeAddress && /NumericInput|ComboBox/.test(r.ctrl || '') && r.min !== '') {
                const writeIdStr = writeId(r.tn);
                const writeKey = JSON.stringify([writeAddress, writeIdStr, decodeKey]);
                if (!seenWriteIds.has(writeKey)) {
                    seenWriteIds.add(writeKey);
                    console.log(`${prefix}w,${cls},${finalN},${cmt},,${writeAddress},5023,${writeIdStr},${finalN},,${t[0]},${t[1]},${csvText(r.unit)},TelegramNr ${r.tn},suffix,,HEX:4,=9d010000,,`);
                }
            }
        }
        if (skippedShared) {
            console.error(
                `# ${dev.reqName}: ${skippedShared} metadata entries skipped because another template already defines the same register at ${dev.address}. ` +
                `If ${dev.reqName} is a separate bus device, map its address with --address ${dev.template.name}=<ZZ>.`
            );
        }
    }
    if (variantsEmitted.length) {
        console.error(`\n# ${variantsEmitted.length} metadata variants emitted commented out (same ID, different type/divider/unit). ebusd allows only one definition per ID; swap one in if it matches your device better:`);
        variantsEmitted.forEach(v => console.error('#   ' + v));
    }
    console.error(`\n# ${readRowsEmitted} read rows emitted for ${deviceNames.join(', ')}.`);
    console.error('# Validate before installing:  ebusd --checkconfig --configpath=<dir> --device=ens:127.0.0.1:59999');
}

ensureFiles().then(main).catch(e => { console.error(String(e)); process.exit(1); });

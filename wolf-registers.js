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
 *   node wolf-registers.js --device DHK_BM-2,MK_BM-2,WW_BM-2,WWSystem_BM-2,MM,ISM,CHA,BM-2            dump that device's registers
 *   node wolf-registers.js --device DHK_BM-2,MK_BM-2,WW_BM-2,WWSystem_BM-2,MM,ISM,CHA,BM-2  --csv     emit ebusd CSV rows
 *   node wolf-registers.js --device DHK_BM-2,MK_BM-2,WW_BM-2,WWSystem_BM-2,MM,ISM,CHA,BM-2  --csv --write   also emit write rows
 *   docker run --rm -v $(pwd):/app -w /app node:latest node wolf-registers-multiple.js --device DHK_BM-2,MK_BM-2,WW_BM-2,WWSystem_BM-2,MM,ISM,CHA,BM-2 --csv --write > wolf-all.csv
 *
 * It downloads three files (~5 MB) on first run and caches them next to itself.
 *
 * Which device are you? Run `ebusctl info` and look at the scanned slave string,
 * e.g.  MF=65;ID=" &";SW=0029;HW=0001 .  ebusd cannot decode Wolf's manufacturer
 * id, and the ID looks like garbage - but those ID bytes are hex. " &" is
 * 0x20 0x26, and 0x26 is exactly the WRSDeviceIds value of the "FGB" template.
 * --list prints WRSDeviceIds for every device so you can match yours.
 *
 * Licence: 0BSD (Zero-Clause BSD)
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

function main() {
    const argv = process.argv.slice(2);
    const want = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };
    const has  = (f) => argv.includes(f);

    const { C, P, D } = load();

    if (has('--list') || (!want('--device'))) {
        console.log('Wolf device templates (match WRSDeviceIds against your ebusd scan ID bytes):\n');
        console.log('  DTID    WRSDeviceIds  params  Name');
        D.sort((a, b) => a.name.localeCompare(b.name)).forEach(d =>
            console.log('  ' + String(d.dtid).padEnd(8) + String(d.wrs).padEnd(14) +
                        String(d.ptids.length).padEnd(8) + d.name));
        console.log('\nThen: node wolf-registers.js --device <Name>,<Name2> [--csv] [--write]');
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

    const csv = has('--csv');
    if (!csv) {
        console.log('Use --csv to output ebusd config format.');
        return;
    }

    // ---- CSV output ----
    console.log('# type,class,name,comment,QQ,ZZ,PBSB,ID,field,part,type,divider,unit,comment');
    console.log(`# Generated by wolf-registers.js for: ${deviceNames.join(', ')}`);
    
    const seenSigs = new Set();
    let readRowsEmitted = 0;
    
    const seenNamesPerClass = {};

    for (const dev of targetDevices) {
        const R = rows(dev.template, C, P);
        
        const cls = slug(dev.reqName.split('_')[0]);
        
        if (!seenNamesPerClass[cls]) seenNamesPerClass[cls] = new Set();

        for (const r of R) {
            if (r.tn === null || r.bit !== null) continue; // bitfields need hand-shaping
            const t = TYPES[r.wolfType]; if (!t) continue;
            
            let n = slug(r.name);
            if (/^[0-9]/.test(n)) {
                n = 'num_' + n;
            }
            
            let finalN = n;
            let i = 2;
            while (seenNamesPerClass[cls].has(finalN)) {
                finalN = n + '_' + (i++);
            }
            seenNamesPerClass[cls].add(finalN);

            const cmt = (r.name || '').replace(/,/g, ' ') + (r.min !== '' ? ` (${r.min}-${r.max})` : '');
            
            // ---- READ ROW ----
            const readIdStr = readId(r.tn);
            const readSig = `08_5022_${readIdStr}`; // Signatur for global deduplication
            
            if (!seenSigs.has(readSig)) {
                seenSigs.add(readSig);
                readRowsEmitted++;
                console.log(`r5,${cls},${finalN},${cmt},,08,5022,${readIdStr},${finalN},,${t[0]},${t[1]},${r.unit || ''},TelegramNr ${r.tn}`);
            }

            // ---- WRITE ROW ----
            if (has('--write') && /NumericInput|ComboBox/.test(r.ctrl || '') && r.min !== '') {
                const writeIdStr = writeId(r.tn);
                const writeSig = `03_5023_${writeIdStr}`; // Signatur for global deduplication
                
                if (!seenSigs.has(writeSig)) {
                    seenSigs.add(writeSig);
                    console.log(`w,${cls},${finalN},${cmt},,03,5023,${writeIdStr},${finalN},,${t[0]},${t[1]},${r.unit || ''},TelegramNr ${r.tn},suffix,,HEX:4,=9d010000,,`);
                }
            }
        }
    }
    console.error(`\n# ${readRowsEmitted} read rows emitted for ${deviceNames.join(', ')}.`);
    console.error('# Validate before installing:  ebusd --checkconfig --configpath=<dir> --device=ens:127.0.0.1:59999');
}

ensureFiles().then(main).catch(e => { console.error(String(e)); process.exit(1); });

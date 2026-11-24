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
 *   ... --csv --write --writable 10903,10905                also emit write rows for these TelegramNrs,
 *                                                         even if Wolf marks them read-only
 *   ... --write --ha-yaml 19,10912                         print Home Assistant MQTT entities (YAML) for
 *                                                         these write rows instead of the CSV
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
// Write addresses confirmed on a real installation (see HISTORY.md and README).
const VERIFIED_WRITE_ADDRESSES = ['03', '30'];
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

/** Wolf KeyValueList "0;Aus;1;Ein" -> ebusd value list "0=Aus;1=Ein", or '' if it cannot be mapped. */
function valueList(kvl) {
    if (!kvl) return '';
    const parts = kvl.replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&quot;/g, "'")
        .replace(/&apos;/g, "'").replace(/&amp;/g, '&').split(';');
    if (parts.length % 2) return '';
    const out = [], keys = new Set();
    for (let i = 0; i < parts.length; i += 2) {
        const key = parts[i].trim();
        if (!/^-?\d+$/.test(key) || keys.has(key)) return '';
        keys.add(key);
        const text = parts[i + 1].replace(/[\r\n,;="]/g, ' ').replace(/\s+/g, ' ').trim();
        if (!text) return '';
        out.push(`${key}=${text}`);
    }
    return out.join(';');
}

/** ebusd decoding for a non-bitfield register: {type, div (divider or value list), unit, note, suffix}, or null. */
function decodingFor(r) {
    // BM2Time: high byte hours, low byte minutes; on the wire minutes come first, which is ebusd's VTM.
    if (r.wolfType === 'BM2Time') return { type: 'VTM', div: '', unit: '', note: ' BM2Time', suffix: '' };
    // BM2Date packs day/month/year into bits; ebusd has no matching type, so expose the raw value.
    if (r.wolfType === 'BM2Date') {
        return { type: 'UIN', div: '', unit: '', suffix: '_raw',
                 note: ' BM2Date raw: day=(v&31)+1 month=((v>>5)&15)+1 year=2000+(v>>9)' };
    }
    const t = TYPES[r.wolfType];
    if (!t) return null;
    let values = t[1] === '' && r.wolfType !== 'UINT32' ? valueList(r.kvl) : '';
    if (/(^|;)-/.test(values)) values = ''; // ebusd value lists do not accept negative keys
    return { type: t[0], div: values || t[1], unit: r.unit || '', note: '', suffix: '' };
}

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
                  max: g('MaxValueCondition'), ctrl: g('ControlType'), kvl: g('KeyValueList'),
                  step: g('StepWidth'), readOnly: g('ReadOnlyConditionId') === 'True' };
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
                   step: p.step, ctrl: p.ctrl, kvl: p.kvl, readOnly: p.readOnly });
    }
    return out.sort((a, b) => (a.tn ?? 1e9) - (b.tn ?? 1e9));
}

const slug = s => (s || '')
    .replace(/[äÄ]/g, 'ae').replace(/[öÖ]/g, 'oe').replace(/[üÜ]/g, 'ue').replace(/ß/g, 'ss')
    .replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').toLowerCase().slice(0, 40) || 'unnamed';

/* ebusd poll priority: rN is polled about every N-th poll round, so lower means more often.
 * Wolf marks measured values as read-only; settings rarely change and are polled least often. */
const POLL_MEASUREMENT = 1, POLL_STATUS = 3, POLL_SETTING = 9;
const pollPriority = (r, dec) => !r.readOnly ? POLL_SETTING : dec.unit ? POLL_MEASUREMENT : POLL_STATUS;

/** ebusd name from a Wolf name: slug, numeric-leading first segment moved to the end, num_ fallback. */
function ebusName(s) {
    let n = slug(s);
    const numericPrefix = n.match(/^([0-9][^_]*)_(.+)$/);
    if (numericPrefix) n = `${numericPrefix[2]}_${numericPrefix[1]}`;
    if (/^[0-9]/.test(n)) n = 'num_' + n;
    return n;
}


/** Text for a CSV field: no separators, quotes or line breaks. */
const csvText = s => (s || '').replace(/[\r\n,";]/g, ' ').trim();

/** Value list texts (off, on) that --ha-yaml turns into a switch instead of a select. */
const ON_OFF_PAIRS = [['aus', 'ein'], ['nein', 'ja'], ['inaktiv', 'aktiv'], ['deaktiviert', 'aktiviert']];

/** Home Assistant MQTT entities (number/select/switch) for ebusd write messages, as YAML on stdout. */
function printHaYaml(entities, selection, prefix) {
    // A JSON string is a valid double-quoted YAML scalar once U+2028/U+2029 (YAML line breaks) are escaped.
    const q = v => JSON.stringify(String(v)).replace(/[\u2028\u2029]/g, c => '\\u' + c.charCodeAt(0).toString(16));
    const num = v => (v !== '' && v !== undefined && v !== null && Number.isFinite(+v)) ? +v : null;
    const numbers = [], selects = [], switches = [];
    // ebusd's %PREFIX: the topic prefix ("ebusd" without --mqtttopic) with every non-alphanumeric character as "_".
    const deviceIdPrefix = prefix.replace(/[^A-Za-z0-9]/g, '_');
    for (const e of entities) {
        const topic = `${prefix}/${e.cls}/${e.name}`;
        const common = [
            `    - name: ${q(e.label || e.name)}`,
            `      unique_id: ${q(`${prefix.replace(/\//g, '_')}_${e.cls}_${e.name}_set`)}`,
            `      state_topic: ${q(topic)}`,
            `      value_template: ${q(`{{ value_json['${e.name}'].value }}`)}`,
            `      command_topic: ${q(topic + '/set')}`,
            // Same device as ebusd's own discovery ("%{PREFIX}_%CIRCUIT" in mqtt-hassio.cfg), so the
            // entities show up under the existing "ebusd <class>" device.
            `      device:`,
            `        identifiers: [${q(`${deviceIdPrefix}_${e.cls}`)}]`,
            `        name: ${q(`${prefix} ${e.cls}`)}`, // ebusd's "%prefixn %circuit"
        ];
        if (String(e.div).includes('=')) {
            // valueList() strips ";" and "=" from the texts, so splitting is safe.
            const options = String(e.div).split(';').map(v => v.slice(v.indexOf('=') + 1));
            if (!options.length || options.some(o => !o) || new Set(options).size !== options.length) {
                console.error(`# --ha-yaml: no entity for TelegramNr ${e.tn} (${e.cls} ${e.name}): empty or duplicate option texts.`);
                continue;
            }
            // A plain off/on list (0=Aus;1=Ein and similar) becomes a switch, everything else a select.
            const off = String(e.div).match(/^0=([^;]+);1=([^;]+)$/);
            if (off && ON_OFF_PAIRS.some(([a, b]) => a === off[1].toLowerCase() && b === off[2].toLowerCase())) {
                switches.push([...common, `      payload_off: ${q(off[1])}`, `      payload_on: ${q(off[2])}`].join('\n'));
                continue;
            }
            selects.push([...common, `      options: [${options.map(o => q(o)).join(', ')}]`].join('\n'));
            continue;
        }
        const min = num(e.min), max = num(e.max), divider = num(e.div);
        const step = +(num(e.step) || (divider && divider > 1 ? 1 / divider : 1)).toPrecision(6);
        if (min === null || max === null || min > max || !(step > 0)) {
            console.error(`# --ha-yaml: no entity for TelegramNr ${e.tn} (${e.cls} ${e.name}): no valid numeric range or step in the metadata.`);
            continue;
        }
        const lines = [...common, `      min: ${min}`, `      max: ${max}`, `      step: ${step}`];
        if (e.unit) lines.push(`      unit_of_measurement: ${q(e.unit)}`);
        lines.push('      mode: box');
        numbers.push(lines.join('\n'));
    }
    console.log('# Home Assistant MQTT entities for ebusd write messages, generated by wolf-registers.js.');
    console.log(`# Topics assume ebusd runs with --mqtttopic=${prefix} and --mqttjson. Merge into the mqtt: section of configuration.yaml.`);
    console.log('mqtt:');
    if (numbers.length) console.log('  number:\n' + numbers.join('\n'));
    if (selects.length) console.log('  select:\n' + selects.join('\n'));
    if (switches.length) console.log('  switch:\n' + switches.join('\n'));
    if (selection) {
        const found = new Set(entities.map(e => e.tn));
        const missing = [...selection].filter(tn => !found.has(tn));
        if (missing.length) console.error(`# --ha-yaml: no write row for TelegramNr ${missing.join(', ')}.`);
    }
    console.error(`# --ha-yaml: ${numbers.length} number, ${selects.length} select and ${switches.length} switch entities.`);
}

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
        console.log('\nThen: node wolf-registers.js --device <Name>,<Name2> [--address <Name>=<ZZ>,<Name2>=<ZZ>] [--class <name>] [--csv] [--write [--writable <TelegramNr>,...] [--ha-yaml all|<TelegramNr>,...] [--mqtt-prefix ebusd]]');
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

    // TelegramNrs that get write rows even though Wolf marks them read-only (for example SmartHome set values).
    /** Set of normalized TelegramNrs from a comma-separated option value; exits on invalid input. */
    const telegramNrList = (value, option) => new Set(value.split(',').map(item => {
        const tn = item.trim();
        if (!/^[0-9]{1,5}$/.test(tn) || +tn > 0xffff) {
            console.error(`Invalid TelegramNr "${item}" for ${option}; expected numbers from 0 to 65535.`);
            process.exit(1);
        }
        return String(+tn);
    }));
    const needsWrite = option => {
        if (!has('--write')) { console.error(`Option ${option} needs --write.`); process.exit(1); }
    };

    // TelegramNrs that get write rows even though Wolf marks them read-only (for example SmartHome set values).
    const writableOption = want('--writable');
    if (writableOption) needsWrite('--writable');
    const forcedWritable = writableOption ? telegramNrList(writableOption, '--writable') : new Set();
    const forcedWritten = new Set();

    // --ha-yaml prints Home Assistant MQTT entities for the write rows instead of the CSV.
    const haYamlOption = want('--ha-yaml');
    if (haYamlOption) needsWrite('--ha-yaml');
    const haSelection = haYamlOption && haYamlOption.trim().toLowerCase() !== 'all'
        ? telegramNrList(haYamlOption, '--ha-yaml') : null;
    const mqttPrefixOption = want('--mqtt-prefix');
    if (mqttPrefixOption && !haYamlOption) { console.error('Option --mqtt-prefix needs --ha-yaml.'); process.exit(1); }
    const mqttPrefix = mqttPrefixOption || 'ebusd';
    if (!/^[A-Za-z0-9_-]+(\/[A-Za-z0-9_-]+)*$/.test(mqttPrefix)) {
        console.error(`Invalid MQTT prefix "${mqttPrefix}"; expected letters, digits, "_" or "-", separated by "/".`);
        process.exit(1);
    }
    const haEntities = [];

    const csv = has('--csv') || Boolean(haYamlOption);
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

    // ---- CSV output (suppressed when --ha-yaml prints YAML instead) ----
    const emit = haYamlOption ? () => {} : line => console.log(line);
    emit('# type,class,name,comment,QQ,ZZ,PBSB,ID,field,part,type,divider,unit,comment');
    emit(`# Generated by wolf-registers.js for: ${deviceNames.join(', ')}`);
    for (const dev of targetDevices) {
        emit(`# ${dev.template.name} (DTID ${dev.template.dtid}, WRSDeviceIds ${dev.template.wrs}, read address ${dev.address})`);
    }
    emit('# read  ID = <crc8 poly 0x5c over low byte, XOR high byte><TelegramNr LE>');
    emit('# write ID = 00<TelegramNr LE>, plus a 4-byte suffix 9d010000');
    emit(`# poll priority: r${POLL_MEASUREMENT} read-only values with unit and bitfields, r${POLL_STATUS} other read-only values, r${POLL_SETTING} settings`);
    emit(`# write address = master address of the read address (read address - 5); verified for ${VERIFIED_WRITE_ADDRESSES.map(w => `${hx(parseInt(w, 16) + 5)} -> ${w}`).join(' and ')}`);

    const seenReadIds = new Map();
    const warnedReadDuplicates = new Set();
    const seenWriteIds = new Set();
    const variantsEmitted = [];
    let readRowsEmitted = 0;
    let writeRowsEmitted = 0;
    // Bitfields: Wolf defines one parameter per bit of a 16-bit telegram. ebusd allows one message per
    // ID, so all bits of a telegram (at one address) are collected and emitted as one multi-field message.
    const bitGroups = new Map();
    const collectBit = (dev, cls, r) => {
        const key = JSON.stringify([dev.address, readId(r.tn)]);
        if (!bitGroups.has(key)) bitGroups.set(key, { cls, address: dev.address, tn: r.tn, bits: new Map() });
        const group = bitGroups.get(key), bit = +r.bit;
        const values = valueList(r.kvl);
        const bitValues = values.split(';').every(v => /^[01]=/.test(v)) ? values : '';
        if (Number.isInteger(bit) && bit >= 0 && bit <= 15 && !group.bits.has(bit)) {
            group.bits.set(bit, { name: r.name, values: bitValues });
        }
    };
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
        } else if (has('--write') && !VERIFIED_WRITE_ADDRESSES.includes(writeAddress)) {
            console.error(`# Warning: write rows for ${dev.reqName} go to ${writeAddress}; only ${VERIFIED_WRITE_ADDRESSES.join(' and ')} have been verified. Test on a harmless register first.`);
        }
        let skippedShared = 0;

        for (const r of R) {
            if (r.tn === null) continue;
            if (r.bit !== null) { collectBit(dev, cls, r); continue; } // emitted per telegram below
            const dec = decodingFor(r);
            if (!dec) continue;
            const t = [dec.type, dec.div];
            const n = ebusName(r.name) + dec.suffix;

            const readIdStr = readId(r.tn);
            const readAddress = dev.address;
            // Same address and ID with the same decoding is the same register: emit it once.
            // A different type, divider or unit is a metadata variant (e.g. TelegramNr 410
            // PRELOAD_Firmware UIN vs Firmware SIN/100). ebusd rejects a second message with the
            // same ID ("duplicate ID"), so variants are emitted commented out for the user to swap in.
            const readKey = JSON.stringify([readAddress, readIdStr]);
            const decodeKey = JSON.stringify([t[0], t[1], dec.unit]);
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
            const prio = pollPriority(r, dec);
            emit(`${prefix}r${prio},${cls},${finalN},${cmt},,${readAddress},5022,${readIdStr},${finalN},,${t[0]},${t[1]},${csvText(dec.unit)},TelegramNr ${r.tn}${dec.note}`);

            // ---- WRITE ROW ----
            // --writable overrides the read-only flag and the missing range, never the control type.
            const tnKey = String(+r.tn);
            const forced = forcedWritable.has(tnKey);
            const inputControl = /NumericInput|ComboBox/.test(r.ctrl || '');
            const editable = !r.readOnly && inputControl && r.min !== '';
            if (has('--write') && writeAddress && !dec.note && inputControl && (editable || forced)) {
                const writeIdStr = writeId(r.tn);
                const writeKey = JSON.stringify([writeAddress, writeIdStr, decodeKey]);
                if (!seenWriteIds.has(writeKey)) {
                    seenWriteIds.add(writeKey);
                    if (forced && !editable) forcedWritten.add(tnKey);
                    if (!isVariant) {
                        writeRowsEmitted++;
                        if (!haSelection || haSelection.has(tnKey)) {
                            haEntities.push({ tn: tnKey, cls, name: finalN, label: r.name, unit: dec.unit,
                                              div: t[1], min: r.min, max: r.max, step: r.step });
                        }
                    }
                    emit(`${prefix}w,${cls},${finalN},${cmt},,${writeAddress},5023,${writeIdStr},${finalN},,${t[0]},${t[1]},${csvText(dec.unit)},TelegramNr ${r.tn}${dec.note},suffix,,HEX:4,=9d010000,,`);
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
    for (const g of bitGroups.values()) {
        if (!g.bits.size) continue;
        const readIdStr = readId(g.tn);
        const key = JSON.stringify([g.address, readIdStr]);
        const conflict = seenReadIds.has(key); // the same ID is already used by a plain register
        const fieldNames = new Set(['reserved']); // padding field name, see below
        const fieldName = bit => {
            const base = ebusName(g.bits.get(bit).name);
            let f = base, i = 2;
            while (fieldNames.has(f)) f = base + '_' + (i++);
            fieldNames.add(f);
            return f;
        };
        const bits = [...g.bits.keys()].sort((a, b) => a - b);
        const low = bits.filter(b => b < 8), high = bits.filter(b => b >= 8);
        const fields = low.map(b => `${fieldName(b)},,BI${b},${g.bits.get(b).values},,`);
        if (high.length) {
            // ebusd moves to the next byte only after bit 7 is consumed: pad the low byte.
            if (!low.length) fields.push(',,IGN:1,,,');
            else if (low[low.length - 1] < 7) {
                const start = low[low.length - 1] + 1;
                fields.push(`reserved,,BI${start}${start === 7 ? '' : ':' + (8 - start)},,,`);
            }
            high.forEach(b => fields.push(`${fieldName(b)},,BI${b - 8},${g.bits.get(b).values},,`));
        }
        const namesForClass = seenNamesPerClass.get(g.cls);
        let name = `bits_${g.tn}`, i = 2;
        while (namesForClass.has(name)) name = `bits_${g.tn}_${i++}`;
        namesForClass.add(name);
        const prefix = conflict ? '#' : '';
        if (conflict) variantsEmitted.push(`${g.cls},${name} (bitfield TelegramNr ${g.tn} at ${g.address})`);
        else {
            seenReadIds.set(key, new Map([['bits', { cls: g.cls, device: '' }]]));
            readRowsEmitted++;
        }
        emit(`${prefix}r${POLL_MEASUREMENT},${g.cls},${name},Bitfield TelegramNr ${g.tn},,${g.address},5022,${readIdStr},${fields.join(',')}`);
    }
    if (haYamlOption) printHaYaml(haEntities, haSelection, mqttPrefix);
    const forcedMissing = [...forcedWritable].filter(tn => !forcedWritten.has(tn));
    if (forcedWritten.size) {
        console.error(`# --writable: write rows forced for TelegramNr ${[...forcedWritten].join(', ')}, which Wolf marks read-only. Check each one with a harmless write first.`);
    }
    if (forcedMissing.length) {
        console.error(`# --writable: no forced write row for TelegramNr ${forcedMissing.join(', ')} (unknown, already writable, not an input control, bitfield, time/date, or no write address).`);
    }
    if (variantsEmitted.length) {
        console.error(`\n# ${variantsEmitted.length} metadata variants emitted commented out (same ID, different type/divider/unit). ebusd allows only one definition per ID; swap one in if it matches your device better:`);
        variantsEmitted.forEach(v => console.error('#   ' + v));
    }
    console.error(`\n# ${readRowsEmitted} read rows${has('--write') ? ` and ${writeRowsEmitted} write rows` : ''} emitted for ${deviceNames.join(', ')}.`);
    console.error('# Validate before installing:  ebusd --checkconfig --configpath=<dir> --device=ens:127.0.0.1:59999');
}

ensureFiles().then(main).catch(e => { console.error(String(e)); process.exit(1); });

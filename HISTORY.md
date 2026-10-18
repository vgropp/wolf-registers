# Wolf boilers on ebusd: the checksum is solved — read *and* write every register

**TL;DR** — The mystery byte in a Wolf read telegram is a CRC8 with polynomial `0x5c` over the
low byte of the TelegramNr, XORed with the high byte. That was the last thing standing between
Wolf's own published parameter database and a complete ebusd config. You no longer need to
copy magic bytes out of somebody else's `08.csv`. There is a script below that generates a
config for **any** of 48 Wolf device templates. Writes work too, and the write format is
different from the read format in a way that explains why so many people's `w` rows do nothing.

Tested on a **Wolf FGB-K-28** (ebusd 25.1, eBUS shield, ioBroker). 22 of 22 generated IDs are
byte-identical to a hand-made config that has worked for years, plus 30 new registers that were
never readable before. Please try it on your CGB / CGB-2 / CGG-2 / COB / CHA / BM-2 and report
back — the derivation is device-independent but I can only prove it on the hardware I own.

---

## 1. Why this has been hard

Wolf publishes no eBUS documentation. Every Wolf config in the wild is hand-made, partial, and
propagated by copy-paste. `--scanconfig` can never help: a Wolf boiler answers the scan with
`MF=65; ID=" &"`, ebusd does not know manufacturer `0x65`, and the ID looks like line noise.

Reads are `ZZ=08`, `PBSB=5022`, three ID bytes:

```
r,heating,dhw_temp,,,08,5022,cc0e00,...
                            ^^^^^^
                            ?? 0e 00      0x000e = 14 = TelegramNr
```

The last two bytes are obviously the TelegramNr little-endian. The **first byte** is the problem.
It is different for every register, the forums call it "the CRC", and the accepted workaround has
been: if nobody has published the byte for the register you want, you cannot read that register.

## 2. The checksum

It is **linear over GF(2)**, which is what makes it recoverable. Take known-good (byte, TelegramNr)
pairs out of any working Wolf `08.csv`, treat each output bit as a linear equation over the 16
index bits plus a constant, and solve. On 22 verified pairs that is heavily over-determined and
gives a unique answer, whose bit-effects are exactly:

```js
function wolfCrc(telegramNr) {
    let c = telegramNr & 0xff;
    for (let i = 0; i < 8; i++)
        c = (c & 0x80) ? (((c << 1) & 0xff) ^ 0x5c) : ((c << 1) & 0xff);
    return (c ^ (telegramNr >> 8)) & 0xff;
}

const hx = n => n.toString(16).padStart(2, '0');
const readId = tn => hx(wolfCrc(tn)) + hx(tn & 0xff) + hx((tn >> 8) & 0xff);
```

**A CRC8 chain with polynomial `0x5c`, init 0, over the LOW byte only — then the HIGH byte is
XORed in and never shifted.** That last part is why it is not any textbook CRC8 and why
table-driven guesses fail.

Checks that matter:

* It reproduces **22 of 22** IDs in a config that has worked for years.
* The linear solve leaves index bits 10–15 **unconstrained** (no training sample used them, since
  all known registers were < 1024). The poly-`0x5c` form pins them as identity on the high byte.
  That extrapolation is confirmed on real hardware: TelegramNr **10010** (high byte `0x27`, far
  outside the training set) generates `771a27` and reads **1.80 bar** of system pressure on my
  boiler. Same for 10013, 10067, 10068, 65019.
* TelegramNr 554 and 644 both produce `de` — a genuine collision, because `0x2a` and `0x84` shift
  to the same value. The high byte disambiguates them. If you have been confused by two registers
  sharing a first byte, that is why.

**Bonus:** running this over an existing config is a good way to find typos. It flagged one in
mine — `hg74` had `d5` where the algorithm says `91`. It had never worked and nobody knew why.

## 3. Writes — and why yours probably do nothing

Writes use a **different** address and a **different** ID format:

| | Read | Write |
|---|---|---|
| Destination | `ZZ=08` (slave) | **`ZZ=03` (master)** |
| PB SB | `5022` | `5023` |
| First ID byte | the checksum | **`00` — writes are not checksummed** |
| Payload | — | value, then a 4-byte suffix **`9d010000`** |

```
w,heating,dhw_target_set,Warmwassersolltemperatur eingestellt,,03,5023,001300,dhw_target_set,,SIN,10,°C,,suffix,,HEX:4,=9d010000,,
```

Two things people get wrong:

1. **The destination is the master address `03`, not `08`.** I had this recorded as "the write
   rows are mis-addressed" — that was wrong, and it had simply never been tested. Sending the same
   write to `ZZ=08` gives `ERR: read timeout`.
2. **`ebusctl write` printing `empty` is SUCCESS, not an error.** A Wolf write is a master-master
   telegram with no data response. `empty` is what a successful one looks like.

Proof, on a deliberately harmless register (`hg07`, heating pump run-on, valid range 0–30 min):

```
$ ebusctl read -m 0 -c heating hg07
2
$ ebusctl write -c heating hg07 3
empty
$ ebusctl read -m 0 -c heating hg07
3
```

And the one that matters — the DHW setpoint, TelegramNr 19, write ID `001300`:

```
before: 45.0
empty
after:  50.0
live:   50.0      <- TelegramNr 3, the derived setpoint, followed
```

**Test writes on something harmless first.** `hg07` or `hg09` are ideal: in-range values change
nothing you will notice, and they read straight back.

## 4. Getting the register list for *your* Wolf device

You do not have to guess which TelegramNrs exist. Wolf's own SmartSet/ISM7 metadata is public
inside [`zivillian/ism7mqtt`](https://github.com/zivillian/ism7mqtt) — `parameter.xml`,
`converter.xml` and `device.xml` under `src/ism7mqtt/Resources/`. Between them they give, for
every Wolf device: TelegramNr, data type, unit, min/max, and the value labels for enums.

`wolf-registers.js` (attached) downloads them and does the join:

```
$ node wolf-registers.js --list
  DTID    WRSDeviceIds  params  Name
  30000   0x18          80      BM
  220000  0x20          139     BM-2
  80000   0x6           45      CGB
  180000  0x21          97      CGB-2
  100000  0x1D          53      CGG-2
  110000  0x1C          53      CGU-2
  270000  0x29          178     CHA
  90000   0x1A          49      COB
  250000  0x26          64      FGB
  ...48 templates
```

**Which one are you?** Look at your ebusd scan string. Mine says `MF=65; ID=" &"`. Those ID bytes
are `0x20 0x26` — and `&` **is** `0x26`, which is exactly the `WRSDeviceIds` of the `FGB`
template. The "garbage" ID is not garbage; it contains your device id. Match it against the list.

```
$ node wolf-registers.js --device FGB
TelegramNr  readID   writeID  Type    Unit   Range        Name
13          280d00   000d00   SS10    °C                  Kesseltemperatur
14          cc0e00   000e00   SS10    °C                  Warmwassertemperatur
19          541300   001300   SS10    °C     30..80       Warmwassersolltemperatur eingestellt
270         cd0e01   000e01   SS100          0..30        Heizkurve
10010       771a27   001a27   SS100   bar                 Anlagendruck
...

$ node wolf-registers.js --device FGB --csv --write > 08-generated.csv
```

Type mapping: `SS10`→`SIN` divider 10, `SS100`→`SIN` divider 100, `US10`→`UIN` divider 10,
`US`→`UIN`, `SS`→`SIN`.

## 5. Things that cost me hours

**`ebusctl read -h` only works for messages ebusd ALREADY KNOWS.** It is not a raw frame sender.
An unknown ID returns `ERR: element not found` without touching the bus. So you cannot use it to
probe for new registers, and "a wrong checksum is rejected" proves nothing about your boiler — it
only proves ebusd's message table did not match.

**`ebusctl hex` and `read -def` need `--enablehex` / `--enabledefine`.** Off by default.

**Validate a config offline, as a normal user, before installing it:**

```
ebusd --checkconfig --configpath=/home/you/ebustest/ --device=ens:127.0.0.1:59999
```

Copy your config tree somewhere writable, edit, check. It prints `found messages: N (... M poll)`
and exits 0 without touching the running daemon or the bus.

**Do not force-read many registers back to back.** I ran 32 sequential `read -m 0` calls and
roughly every other one came back empty, with the symbol rate spiking to 102. It looks exactly
like "this register is unsupported" and it is not. Read the **poll cache** instead —
`ebusctl find -a -c heating` — giving it a couple of minutes after `ebusctl reload` to refill.

**Adding a write row whose name matches an existing read row does NOT increase `messages:`.**
ebusd merges them into one message with two directions. Check with `ebusctl find -w -c heating`,
not the count. I briefly misread this as a rejected row.

**Polling more costs nothing.** I went from 28 to 60 polled messages and the bus symbol rate
stayed at **12**, exactly as before. Poll priority (`r1`…`r9`) controls how often each is polled,
not how much traffic there is in total.

**Values reading `32768` or `3276.8` are the eBUS null sentinel** — "this register does not exist
on this device". Six of mine had been dead for years. Their TelegramNrs (39, 321, 362, 365, 368)
simply are not in the FGB parameter list; they had been copied from a different Wolf model. No
config change will ever fix those, and now you can tell the difference between "wrong byte" and
"not present" by checking the generated list.

## 6. ioBroker integration

**MQTT.** ebusd's own MQTT integration publishes reads fine:

```
--mqttint=/etc/ebusd/mqtt-integration.cfg --mqtthost=127.0.0.1 --mqttport 1883 ...
```

Note it ships `filter-direction = r|u`, i.e. **read-only** — it will not accept writes. To write
from a script, shell out:

```js
exec('ebusctl write -c heating dhw_target_set 50', () => {
    exec('ebusctl read -m 0 -c heating dhw_target_set', (e, out) => log('now ' + out));
});
```

Always read back and verify. A write that silently does nothing is the failure mode here.

**Poll priority gotcha.** If you use the Home Assistant MQTT profile, `filter-seen = 5` silently
promotes matched messages to poll priority 5. Remove it and everything goes to `no data stored`
because nothing is polled any more. Declare priority in the CSV instead (`r5,heating,...`).

**Two scripts are attached:**

* `boiler_status_en.js` — turns the raw enum numbers into readable states under
  `0_userdata.0.heating.boiler.*`: `status`, `mode`, `burner_status`, `firing`, `fault`, `alive`,
  plus a one-line `summary` like `Firing at 28% — Heating mode`. `fault` is the one worth
  alarming on: true when `burner_status` is 12 (Störung) or the safety limiter has tripped.
  `alive` watches staleness across several polled registers, because the boiler powers the eBUS —
  so a dead bus means a dead boiler.
* `boiler_aliases.js` — a stable `alias.0.boiler.*` layer so renaming an ebusd message does not
  break every widget and chart. It refuses to create an alias whose source does not exist and
  tells you which ones to fix.

**Useful enum decodings** (from Wolf's own `KeyValueList`, FGB — check yours with the tool):

```
burner_status  0 Aus · 1 Ruhekontakt · 2 Vorspülen · 3 Zünden · 4 Stabilisierung · 5 Ein ·
               6 Ventilprüfung · 7 Nachspülen · 8 Softstart · 9 Taktsperre ·
               10 Betrieb ohne Brenner · 11 Abgasklappe · 12 Störung · 13 Gradienten Überwachung ·
               14 Gasdruck · 15 Spreizung hoch · 16 Spreizung KF
operating_mode 0 Test · 1 Start · 2 Frost Heizkreis · 3 Frost Warmwasser · 4 Schornsteinfeger ·
               5 Kombibetrieb · 6 Parallelbetrieb · 7 Warmwasser · 8 Warmwassernachlauf ·
               9 Mindest-Kombizeit · 10 Heizbetrieb · 11 Nachlauf Heizkreispumpe ·
               12 Frostschutz · 13 Standby · 14 Kaskadenbetrieb · 15 GLT-Betrieb ·
               16-19 Kalibration · 20 WW Schnellstart · 21 Externe Deaktivierung
program (10100) 1 Aus · 3 Winterbetrieb · 5 Sommerbetrieb
TelegramNr 370 bit 3          = Brenner
TelegramNr 371 bits 0,1,2,4,5 = Zündung, Ventil 1, Ventil 2, Kesselkreispumpe, 3-Wege-Ventil
```

## 7. Safety

This is a gas appliance. A few things I would not do:

* **Do not write to a register you have not looked up.** The generated table gives the valid
  range; stay inside it. Writing outside a documented range is not something I have tested and
  not something I would.
* **Prove writes on a harmless parameter first** (`hg07`, `hg09`), read back, restore.
* **Do not try to make ebusd the heating controller.** Emulating the controller broadcast means
  repeating it forever, and if your automation dies in winter so does your frost protection. For
  simple on/off demand a relay across the room-thermostat contact fails safe; this does not.
* **Back up `08.csv` before every change** and keep `ebusd --checkconfig` in the loop.
* Writes change settings **in the boiler**, persistently. They survive a reboot of everything
  else. Write down what you changed.

## 8. What it got me

A Wolf FGB-K-28 that exposed 28 registers, six of them permanently dead, now exposes 60 — at
identical bus load. New and working:

**Anlagendruck** (system pressure, bar) · **Abgastemperatur** (flue gas) · **Modulationsgrad** ·
**Brennerstatus** (17 states) · **Betriebsart** (20 modes) · **Brenner**, **Zündung**,
**Ventil 1/2**, **Kesselkreispumpe**, **3-Wege-Ventil** (six real digital signals) ·
**Drehzahl Kesselkreispumpe / ZHP WW** · **Heizkurve** · **Firmware** · **Anlagendruck** ·
**Auslauftemperatur Warmwasser** · **Sicherheitstemperaturbegrenzer** · **Anzahl Netz-Starts** ·
and roughly fifteen more.

Plus working writes, which turned into an automated weekly DHW disinfection cycle and a
vacation setback.

Three errors found in a config that had been running for years: a wrong checksum on `hg74`,
`hg75` typed as minutes when TelegramNr 364 is **litres per minute** (it is the DHW flow rate),
and six registers that do not exist on this device at all.

---

### Files

| | |
|---|---|
| `wolf-registers.js` | generates the register table / ebusd CSV for any Wolf device |
| `boiler_status_en.js` | ioBroker: decoded status states + fault/alive flags |
| `boiler_aliases.js` | ioBroker: stable `alias.0.boiler.*` layer |

### Credit

The parameter database is [zivillian/ism7mqtt](https://github.com/zivillian/ism7mqtt)'s extraction
of Wolf's SmartSet metadata — without it none of this is possible. ebusd is
[john30/ebusd](https://github.com/john30/ebusd). The forum threads that got me oriented are
[ebusd discussion #779](https://github.com/john30/ebusd/discussions/779) and
[#721](https://github.com/john30/ebusd/discussions/721).

Corrections welcome, especially from anyone who can confirm or refute the checksum on a non-FGB
Wolf device.

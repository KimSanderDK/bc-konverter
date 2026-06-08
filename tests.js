/*
 * BC Konverter — regressionstests for de rene data-funktioner.
 *
 * HVAD: Tjekker automatisk at pris- og EAN-beregningerne giver de rigtige svar.
 *       Hver test svarer til en fejl der ÉN GANG nåede Business Central:
 *         - "16215,09" der blev til 12 mio. DKK   (parsePrice, v2.9.5)
 *         - dubletvarer i BC pga. ledende nul      (eanMatchKey/output, v2.9.6-2.9.7)
 *         - dubletter i kildefil                   (dedupItemsLastWins)
 *
 * HVORDAN: Testen UDTRÆKKER funktionerne direkte fra BC_Prisliste_Konverter.html
 *          og kører mod dem. Den tester altså den FAKTISKE deployede kode — ikke en
 *          kopi der kan drive fra hinanden. Samme idé som jeres "node --check"-trin.
 *          Selve appen røres ikke; dette er en separat fil.
 *
 * KØR:  node tests.js                       (bruger ./BC_Prisliste_Konverter.html)
 *       node tests.js sti/til/index.html    (peg på en bestemt version)
 *
 * Grøn = alt OK. Rød + exit-kode 1 = noget er gået i stykker (fang det FØR det rammer BC).
 */
'use strict';
const fs = require('fs');

// ---- 1) Find og indlæs HTML-kildekoden -------------------------------------
const htmlPath = process.argv[2] || 'BC_Prisliste_Konverter.html';
if (!fs.existsSync(htmlPath)) {
  console.error('Kunne ikke finde HTML-filen: ' + htmlPath);
  console.error('Kør:  node tests.js sti/til/BC_Prisliste_Konverter.html');
  process.exit(2);
}
const html = fs.readFileSync(htmlPath, 'utf8');

// ---- 2) Udtræk de navngivne top-level-funktioner fra kildekoden ------------
// De er alle top-level (afsluttende "}" i kolonne 0), så vi fanger fra
// "function NAVN(" til den første linje der starter med "}".
function extractFn(name) {
  const re = new RegExp('function\\s+' + name + '\\s*\\([^]*?\\n\\}', 'm');
  const m = html.match(re);
  if (!m) throw new Error('Funktionen "' + name + '" blev ikke fundet i ' + htmlPath +
    ' — er den omdøbt eller flyttet? (Testen skal opdateres, eller funktionen mangler.)');
  return m[0];
}

const NAMES = ['safeStr', 'normalizeEAN', 'eanMatchKey', 'parseCSV', 'parsePrice', 'dedupItemsLastWins'];
const source = NAMES.map(extractFn).join('\n\n');

// Evaluér funktionerne i et isoleret scope og hent referencer ud.
let safeStr, normalizeEAN, eanMatchKey, parseCSV, parsePrice, dedupItemsLastWins;
try {
  // eslint-disable-next-line no-eval
  eval(source + '\n;([safeStr,normalizeEAN,eanMatchKey,parseCSV,parsePrice,dedupItemsLastWins]);');
  const fns = eval(source + '\n;[safeStr,normalizeEAN,eanMatchKey,parseCSV,parsePrice,dedupItemsLastWins];');
  [safeStr, normalizeEAN, eanMatchKey, parseCSV, parsePrice, dedupItemsLastWins] = fns;
} catch (e) {
  console.error('Kunne ikke indlæse funktionerne fra HTML:', e.message);
  process.exit(2);
}

// ---- 3) Lille assert-ramme -------------------------------------------------
let passed = 0, failed = 0;
const fails = [];
function check(name, cond, got, want) {
  if (cond) { passed++; }
  else {
    failed++;
    fails.push('  ✗ ' + name +
      (got !== undefined ? ('\n      fik:  ' + JSON.stringify(got) + '\n      vil:  ' + JSON.stringify(want)) : ''));
  }
}
const eq = (name, got, want) => check(name, JSON.stringify(got) === JSON.stringify(want), got, want);
const approx = (name, got, want) => check(name, typeof got === 'number' && Math.abs(got - want) < 1e-6, got, want);
const isNaNv = (name, got) => check(name, typeof got === 'number' && Number.isNaN(got), got, 'NaN');

// ============================================================================
// parsePrice — kernen i 12-mio.-DKK-fejlen
// ============================================================================
approx('parsePrice: svensk komma-decimal "16215,09" → 16215.09', parsePrice('16215,09'), 16215.09);
check('parsePrice: "16215,09" blev IKKE 1621509', parsePrice('16215,09') !== 1621509, parsePrice('16215,09'), '≠ 1621509');
approx('parsePrice: regressionscase × kurs 7,5 ≈ 121613 (ikke 12 mio.)', parsePrice('16215,09') * 7.5, 121613.175);
approx('parsePrice: rigtig talcelle (number) passerer urørt', parsePrice(16215.09), 16215.09);
approx('parsePrice: europæisk "1.621.509,09" → 1621509.09', parsePrice('1.621.509,09'), 1621509.09);
approx('parsePrice: amerikansk "1,621,509.09" → 1621509.09', parsePrice('1,621,509.09'), 1621509.09);
approx('parsePrice: valutasymbol "€ 16215,09" strippes → 16215.09', parsePrice('€ 16215,09'), 16215.09);
approx('parsePrice: NBSP+tegn "1\u00a0234,50 kr" → 1234.50', parsePrice('1\u00a0234,50 kr'), 1234.5);
approx('parsePrice: kun punktum "1234.56" → 1234.56', parsePrice('1234.56'), 1234.56);
approx('parsePrice: heltal "12" → 12', parsePrice('12'), 12);
isNaNv('parsePrice: tom streng → NaN', parsePrice(''));
isNaNv('parsePrice: null → NaN', parsePrice(null));
isNaNv('parsePrice: kun minus "-" → NaN', parsePrice('-'));

// ============================================================================
// normalizeEAN — xlsx-output: ledende nul BEVARES
// ============================================================================
eq('normalizeEAN: bevarer ledende nul', normalizeEAN('0606449175073'), '0606449175073');
eq('normalizeEAN: fjerner Excel-apostrof-prefix', normalizeEAN("'0606449175073"), '0606449175073');
eq('normalizeEAN: fjerner mellemrum og NBSP', normalizeEAN(' 0606449175073\u00a0'), '0606449175073');
eq('normalizeEAN: tal bliver til streng', normalizeEAN(606449175073), '606449175073');

// ============================================================================
// eanMatchKey — matching: ledende nul STRIPPES (UPC-A == EAN-13)
//   (Dette er kernen i BC-dublet-fejlen v2.9.6-2.9.7)
// ============================================================================
eq('eanMatchKey: stripper ledende nul', eanMatchKey('0606449175073'), '606449175073');
eq('eanMatchKey: uden nul uændret', eanMatchKey('606449175073'), '606449175073');
check('eanMatchKey: UPC-A (12) MATCHER EAN-13 (13 m. nul) — samme produkt',
      eanMatchKey('0606449175073') === eanMatchKey('606449175073'), true, true);
eq('eanMatchKey: "000" → "0" (ægte nul-værdi bevares)', eanMatchKey('000'), '0');
eq('eanMatchKey: tom → tom', eanMatchKey(''), '');

// ============================================================================
// Output-reglen: CSV strippes (BC GTIN uden nul), xlsx bevares.
//   Låser den bevidste forskel fra v2.9.7 fast, så en fremtidig ændring der
//   ved et uheld behandler dem ens bliver fanget.
// ============================================================================
const gtin = '0606449166576';
check('output-regel: CSV (eanMatchKey) ≠ xlsx (normalizeEAN) for samme GTIN',
      eanMatchKey(gtin) !== normalizeEAN(gtin), true, true);
eq('output-regel: CSV-output uden ledende nul', eanMatchKey(gtin), '606449166576');
eq('output-regel: xlsx-output med ledende nul', normalizeEAN(gtin), '0606449166576');

// ============================================================================
// parseCSV — bevarer RÅ strenge (modgift mod SheetJS' type-coercion)
// ============================================================================
const csvComma = 'Model,EAN,Price\nCSM4532-100EUS,"0606449175073","16215,09"\n';
const rowsComma = parseCSV(csvComma);
eq('parseCSV: komma-delimiter, 2 rækker', rowsComma.length, 2);
eq('parseCSV: pris i anførselstegn bevares RÅT som "16215,09"', rowsComma[1][2], '16215,09');
eq('parseCSV: ledende nul i EAN bevares', rowsComma[1][1], '0606449175073');

const csvSemi = 'Model;EAN;Price\nX;0606449175073;16215,09\n';
eq('parseCSV: semikolon-delimiter auto-detekteres', parseCSV(csvSemi)[1][0], 'X');
eq('parseCSV: semikolon — EAN-nul bevaret', parseCSV(csvSemi)[1][1], '0606449175073');

const csvTab = 'Model\tEAN\nY\t0606449175073\n';
eq('parseCSV: tab-delimiter auto-detekteres', parseCSV(csvTab)[1][1], '0606449175073');

const csvBlank = 'A,B\n1,2\n\n3,4\n';
eq('parseCSV: tomme linjer springes over (3 rækker, ikke 4)', parseCSV(csvBlank).length, 3);

const csvBOM = '\uFEFFModel,Price\nZ,9\n';
eq('parseCSV: BOM fjernes fra første felt', parseCSV(csvBOM)[0][0], 'Model');

// End-to-end: hele den fejlramte sti (CSV-celle → parsePrice)
approx('end-to-end: parsePrice(parseCSV-celle) = 16215.09, ikke en million',
       parsePrice(rowsComma[1][2]), 16215.09);

// ============================================================================
// dedupItemsLastWins — sidste forekomst vinder (matcher BC)
// ============================================================================
const deduped = dedupItemsLastWins([
  { id: 'A', v: 1 }, { id: 'B', v: 2 }, { id: 'A', v: 3 },
]);
eq('dedupItemsLastWins: 2 unikke ID efter dedup', deduped.length, 2);
eq('dedupItemsLastWins: A beholder SIDSTE værdi (v=3)',
   deduped.find(x => x.id === 'A').v, 3);
eq('dedupItemsLastWins: poster uden id springes over',
   dedupItemsLastWins([{ id: 'A' }, {}, { foo: 1 }]).length, 1);

// ---- 4) Resultat -----------------------------------------------------------
console.log('\nBC Konverter — funktionstests  (kilde: ' + htmlPath + ')');
console.log('-------------------------------------------------------------');
if (failed === 0) {
  console.log('  ✓ Alle ' + passed + ' tests bestået.\n');
  process.exit(0);
} else {
  console.log('  ' + passed + ' bestået, ' + failed + ' FEJLEDE:\n');
  console.log(fails.join('\n') + '\n');
  process.exit(1);
}

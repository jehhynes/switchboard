import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Which terms the recogniser boosts as hotwords (architecture.md § Dictation), from claude-collab's `terms.js`. The fixed terms are always
 * boosted: `voice/terms/user.txt` in the Switchboard home for every session, plus `voice/terms/repos/<owner>/<repo>.txt` for the repository of
 * the target's folder, when that file exists. A term learnt from a heard tag is kept only if it is a name or a technical term, judged by the
 * meant term alone: a term in the user list passes; a one-word term passes only if it is not a common English word; a term of several words
 * passes only if each word is either not a common word or capitalized, so "Support Code" and "Code Mode" pass and "voice model" does not. Learnt
 * everyday words ("wait", "test", "main") made recognition worse when boosted; distinctive names help.
 */

/** One term per line; blank lines and `#` comments are skipped. A missing file is empty. */
export function readTerms(file: string): string[] {
  let text: string;

  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return [];
  }

  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/#.*/, '').trim().replace(/\s+/g, ' ').normalize('NFC'))
    .filter((line) => line !== '');
}

/** The folder of the fixed term lists. */
export function termsDir(voiceHome: string): string {
  return join(voiceHome, 'terms');
}

/** The user terms, then the repository's (`owner/name`), each once, ignoring case. */
export function fixedTerms(voiceHome: string, repo: string | null): string[] {
  const user = readTerms(join(termsDir(voiceHome), 'user.txt'));
  const [owner, name] = repo?.split('/') ?? [];
  const repoTerms = owner === undefined || name === undefined ? [] : readTerms(join(termsDir(voiceHome), 'repos', owner, `${name}.txt`));
  const seen = new Set<string>();
  const terms: string[] = [];

  for (const term of [...user, ...repoTerms]) {
    if (!seen.has(term.toLowerCase())) {
      seen.add(term.toLowerCase());
      terms.push(term);
    }
  }

  return terms;
}

/** About 1,800 of the most frequent English words. */
export const COMMON_WORDS: ReadonlySet<string> = new Set(
  `
holder dying lying tying
a able about above absolute accept access accident according account across act action active
activity actor actually add address admit adult affect afraid after afternoon again against age
agency agent ago agree agreement ahead aim air alive all allow almost alone along already also
although always am amazing among amount an analysis and angry animal annual another answer anxiety
any anybody anyone anything anyway apart apartment apparently appear apple apply appreciate approach
appropriate approve are area argue arm around arrange arrest arrive art article as aside ask asleep
assume at attack attempt attend attention attitude attract audience author authority available
average avoid awake award aware away baby back bad bag balance ball band bank bar base basic basis
battle be bear beat beautiful because become bed bedroom been beer before begin behavior behind
being believe bell belong belt bench benefit best better between beyond big bike bill bird birth
birthday bit bite black blame blank blind block blood blow blue board boat body bone bonus book
border born boss both bother bottom bowl box boy brain branch brave bread break breakfast breath
brief bright bring broad broken brother brown budget build building bunch burn bus business busy but
button buy by cable cake calculate call calm came camera camp campaign can cancel cancer candidate
capable capital captain capture car card care career careful carry case cash cast cat catch category
cause ceiling celebrate cell center central century certain certainly chain chair challenge champion
chance change channel chapter character charge chat cheap check cheese chest chicken chief child
chip choice choose church circle citizen city civil claim class clean clear clearly clever click
climb clock close closer cloth clothes cloud club cluster coach coast coat code coffee cold collect
collection college color column combine come comfortable command comment commercial commit committee
common communicate community company compare compete complain complete complex computer concept
concern concert condition conference confidence confirm conflict connect connection consider
constant construct consumer contact contain content contest context continue contract contribute
control conversation convert cook cool copy corner corporate correct cost couch could council count
counter country county couple courage course court cover crash crazy cream create credit crew crime
criminal crowd crucial cry cultural culture cup cure curious current curve customer cut cycle dad
damage dance danger dark data date daughter day dead deadline deal dear death debate debt decade
decide decision deck declare deep defeat defense define degree delay delete deliver demand
democratic deny depend deploy depth describe deserve design desire desk despite destroy detail
determine develop development device did die diet difference different difficult dig digital dinner
direct direction director dirt dirty disaster discount discover discuss discussion disease dish
display distance divide do doc doctor document does dog doing dollar domain done door double down
draft drag drama draw drawer drawing dream dress drink drive drop drug dry during dust duty each
eager ear early earn earth ease east easy eat economic economy edge edit education effect effective
efficient effort egg eight either elect election element else emergency emotion emphasis employ
employee empty enable encourage end enemy energy engage engine engineer enjoy enormous enough ensure
enter entire entry environment environmental episode equal equipment error escape especially essay
essential establish estate estimate evaluate even evening event ever every everybody everyone
everything evidence exact exactly exam example excellent exchange excite excuse executive exercise
exist expand expect expense experience expert explain explore expose express extend extra extreme
eye fabric face facility fact factor fail fair fake fall false familiar family famous fan far farm
fashion fast fat father fault favorite fear feature federal fee feed feel feeling felt female fence
few fiction field fight figure file fill film final finally finance financial find fine finger
finish fire firm first fish fit five fix fixed flag flash flat flight float floor flow flower fluid
fly focus fold folder follow food foot for force foreign forget fork form formal format former
fortune forward found four frame free frequent fresh fridge friend from front fruit fuel full fun
function fund funny future game gap garden gas gate gather gave gear general generation gentle
gesture get ghost giant gift girl give given glad glass go goal gold gone good goods got government
grab grade grand grant grass grateful gravity gray great green grip ground group grow growth
guarantee guard guess guide gun guy habit had hair half hand handle hang happen happy hard harm has
hat hate have having he head heading health hear heart heat heavy height hell hello help her here
hero herself hey hi hide high highlight hill him himself hire his history hit hold hole holiday home
honest honor hook hope horror horse hospital host hot hotel hour house household how however huge
human hundred hunt hurry hurt husband i ice idea ideal identify if ignore illegal illness image
imagine impact important impose impress improve in inch include including income increase indeed
indicate individual industry infant inform information initial injury input insert inside insist
install instance instead institution intend interest interesting internal international internet
interview into investment invite involve iron is island issue it item its itself jacket job join
joint joke judge juice jump junior jury just justice keep kept key kick kid kill kind king kiss
kitchen knew know knowledge known label labor lack ladder lady lake land language laptop large last
late later laugh law lawyer lay layer lazy lead leader league leak lean learn least leave lecture
left leg legal lend less lesson let letter level liberal library license lie life lift light like
likely limit line link liquid list listen little live load loan lobby local lock logic long look
loose lord lose loss lot loud love low luck lucky lunch luxury machine mad made magazine mail main
maintain major majority make male man manage management manager manner manual many map margin mark
market marriage master match mate material math matter maximum may maybe me meal mean measure meat
mechanism media medical medium meet meeting melt member memory mental mention menu mere mess message
met metal method metric middle might mild mile military milk million mind mine minimum minor minute
mirror miss mission mistake mix mobile mode model modern mom moment money monitor month mood moon
more morning most mother motion motor mount mouse mouth move movement movie mr mrs much mud mum
muscle museum music must my myself mystery name narrow nation national natural nature near nearly
necessary neck need nervous network neutral never new news newspaper next nice night no none nope
nor normal north nose not note nothing notice novel now nuclear number numerous nurse object obvious
occur ocean odd of off offense offer office officer official often oh oil ok okay old on once one
ones online only onto open operate operation opinion opportunity oppose option or orange order
ordinary organization origin other others our out output outside oven over overall own owner pace
pack package page paid pain paint painting pair palm panel panic pants paper parent park parking
part participant particular particularly partner party pass passage passenger past paste patch path
patient pattern pause pay peace peak pen pencil people pepper per perform performance perhaps period
permit person personal pet phase phone photo phrase physical pick picture piece pilot pin pink pipe
pitch place plain plan planet plant plastic plate platform play player please plenty plot plus pm
pocket poem poet point pole police policy political politics pool poor popular population port
portion pose position positive possible post pot pound pour powder power practice praise pray
precise prefer premium prepare presence present president press pressure pretty prevent price pride
prime principle print prior priority private prize probably problem process produce product
production professional professor profile profit program project promise prompt proof proper
property protect proud prove provide public publish pull punch pure purpose pursue push put puzzle
quality quarter queen question quick quickly quiet quite quote race radio rail rain raise ran random
range rank rapid rare rate rather rating raw reach reaction read ready real reality realize really
reason rebuild receive recent recently recipe recognize record recover red reduce refer reflect
reform refuse regard region regular reject relate relationship relax release relevant relief
religious reload rely remain remember remote remove rent repair repeat replace reply report
represent republican request require rescue research reserve resist resolve resort resource respect
respond response responsibility rest restart result retire return reveal review reward rhythm rich
rid ride right ring rise risk river road rock role roll roof room root rough round route routine row
rub rule run rush sad safe said salt same sample sand sat satisfy save saw say says scale scene
schedule scheme school science scientist scope score scratch screen script sea seal search season
seat second secret section security see seek seem seen segment select self sell send senior sense
sequence series serious serve service session set setting settle seven several severe shade shadow
shake shape share sharp she sheet shell shift shine ship shirt shock shoe shoot shop short shot
should shoulder show shower shut sick side sigh sight sign signal significant silence silent silly
silver similar simple simply since sing single sink sir sister sit site situation six size skill
skin skip sky sleep slice slide slight slip slow small smart smell smile smooth snow so soap social
society soft soldier solid solution solve some somebody someone something sometimes son song soon
sorry sort sound soup source south southern space span spare speak special specific speech speed
spell spend spin spirit split sport spot spread spring square stable stack staff stage stake stamp
stand standard star stare start state statement station stay steady steal steel stem step stick
still stir stock stomach stone stood stop store storm story straight strange strategy street
strength stress stretch strike string strip strong structure struggle student study stuff stupid
style subject submit success successful such suddenly suffer sugar suggest suit sum summer sun
supply support suppose sure surface surprise survey survive suspect sweet swim swing switch symbol
sympathy system tab table tackle tag tail take talk tall tape target task taste tax tea teach
teacher team tear teaspoon technology television tell temperature temporary ten tend tent term
terrible test text than thank that the their them theme themselves then theory there these they
thick thin thing think third this those though thought thousand thread threat three throat through
throughout throw thus ticket tie tight time tiny tip tired tissue title to today toe together told
tomorrow tone tongue tonight too took tool tooth top topic total touch tough tour toward towel tower
town toy trace track trade traditional trail train training transfer travel treat treatment tree
trend trial trick trip troop trouble truck true trust truth try tube tune turn tv twice twin two
type typical uh um uncle under understand understood unique unit unless until up update upload upon
upper upset urban urge us use user usually vacation valley value variety various vast vehicle
version very vessel victim video view violence virus visible vision visit visual vital voice volume
vote wage wait wake walk wall wander want war warm warn was wash waste watch water wave way we
wealth weapon wear weather wedding week weekend weight weird welcome well went were west western wet
what whatever wheel when where whether which while whisper white who whole whom whose why wide wife
wild will win wind window wing wire wise wish with within without witness woman won wonder wood word
work worker world worry worse worst worth would wow wrap write writer written wrong wrote yard yeah
year yellow yes yesterday yet you young your yourself youth zero
`
    .trim()
    .split(/\s+/),
);

/** The forms a word may be inflected from: "sessions" from "session", "replies" from "reply", "running" from "run"; never a stem under 3 letters. */
function stems(word: string): string[] {
  const out = [word];
  const add = (stem: string): void => {
    if (stem.length >= 3) {
      out.push(stem);
    }
  };

  if (word.endsWith("'s")) add(word.slice(0, -2));
  if (word.endsWith('ies')) add(`${word.slice(0, -3)}y`);
  if (/(?:s|x|z|ch|sh|o)es$/.test(word)) add(word.slice(0, -2));
  if (word.endsWith('s') && !word.endsWith('ss')) add(word.slice(0, -1));
  if (word.endsWith('ied')) add(`${word.slice(0, -3)}y`);
  if (word.endsWith('ying')) add(`${word.slice(0, -4)}ie`);

  for (const suffix of ['ed', 'ing']) {
    if (!word.endsWith(suffix)) {
      continue;
    }

    const stem = word.slice(0, -suffix.length);

    add(stem);
    add(`${stem}e`);

    if (stem.length >= 4 && stem.at(-1) === stem.at(-2)) {
      add(stem.slice(0, -1));
    }
  }

  return out;
}

/** A capitalized word is a name unless the list has it as written, so "Ares" is not read as "are"; a hyphenated word is common only if each part is. */
export function isCommonWord(word: string): boolean {
  if (word.includes('-')) {
    const parts = word.split('-').filter(Boolean);

    return parts.every(isCommonWord) && !parts.every((part) => /^\p{Lu}/u.test(part));
  }

  const lower = word.toLowerCase();

  return /^\p{Lu}/u.test(word) ? COMMON_WORDS.has(lower) : stems(lower).some((stem) => COMMON_WORDS.has(stem));
}

/** Whether a learnt meant term may become a hotword; `user` holds the user terms, which always pass. */
export function isLearnable(term: string, user: readonly string[] = []): boolean {
  const text = term.normalize('NFC').replace(/[\u2018\u2019]/g, "'").trim().replace(/\s+/g, ' ');

  if (text === '') {
    return false;
  }

  if (user.some((one) => one.toLowerCase() === text.toLowerCase())) {
    return true;
  }

  const words = text
    .split(/[^\p{L}\p{M}\p{N}'-]+/u)
    .map((word) => word.replace(/^['-]+|['-]+$/g, ''))
    .filter(Boolean);

  if (words.length === 0) {
    return false;
  }

  return words.length === 1 ? !isCommonWord(words[0]!) : words.every((word) => !isCommonWord(word) || /^\p{Lu}/u.test(word));
}

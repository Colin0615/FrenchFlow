import React, { useState, useEffect, useRef, useMemo, useContext, createContext } from 'react';
import {
  Settings, Book, Brain, GraduationCap, Play, Volume2, X, RefreshCw,
  Briefcase, Coffee, AlertTriangle, Save, Search, CheckCircle, Camera,
  Pause, User, LogOut, Cloud, Music, Type
} from 'lucide-react';

// --- FIREBASE IMPORTS ---
import { initializeApp } from 'firebase/app';
import {
  getAuth, signInWithEmailAndPassword, createUserWithEmailAndPassword,
  signOut, onAuthStateChanged, signInWithCustomToken
} from 'firebase/auth';
import type { User as FirebaseUser, Auth } from 'firebase/auth';
import {
  getFirestore, doc, setDoc, getDoc, collection,
  query, where, getDocs, writeBatch, deleteDoc, Firestore
} from 'firebase/firestore';
declare const __initial_auth_token: string | undefined;

// ==========================================
// 0. FIREBASE 配置
// ==========================================
const firebaseConfig = {
  apiKey: "AIzaSyDseqEL0u9cC_fhVNc3vC4RGpfQkb_5O78",
  authDomain: "frflow.firebaseapp.com",
  projectId: "frflow",
  storageBucket: "frflow.firebasestorage.app",
  messagingSenderId: "699516569796",
  appId: "1:699516569796:web:b2b7930c19770b00d56191",
  measurementId: "G-9WT1P6DK03"
};

// 初始化 Firebase
let app: any;
let auth: Auth | null = null;
let db: Firestore | null = null;

try {
  if (firebaseConfig.apiKey) {
    app = initializeApp(firebaseConfig);
    auth = getAuth(app);
    db = getFirestore(app);
  } else {
    console.warn("Firebase 配置为空，运行在离线/本地演示模式");
  }
} catch (e) { console.error("Firebase init error:", e); }

// ==========================================
// 1. 类型定义与上下文
// ==========================================

type AIModelType = 'gemini' | 'openai';
type TTSProvider = 'browser' | 'google_cloud' | 'openai';
// 法语使用 CEFR 等级替代 JLPT
type CEFRLevel = 'A1' | 'A2' | 'B1' | 'B2' | 'C1' | 'C2';

interface AppSettings {
  geminiKey: string;
  openaiKey: string;
  googleTTSKey: string;
  selectedModel: AIModelType;
  ttsProvider: TTSProvider;
  userName: string;
}

// 默认设置
const DEFAULT_SETTINGS: AppSettings = { 
  geminiKey: '', 
  openaiKey: '', 
  googleTTSKey: '',
  selectedModel: 'gemini', 
  ttsProvider: 'browser',
  userName: 'Guest' 
};

// 创建 Settings Context
const SettingsContext = createContext<AppSettings>(DEFAULT_SETTINGS);

// 法语音标片段（替代日语振假名）
interface PhoneticSegment {
  text: string;
  phonetic?: string; // IPA 音标或简化音标
}

// 法语字母详情
interface LetterDetail {
  char: string;           // 字母
  name: string;           // 字母名称读音
  phonetic: string;       // 音标
  sound: string;          // 发音描述
  examples: {
    lifestyle: { word: PhoneticSegment[]; meaning: string; sentence: PhoneticSegment[]; translation: string; };
    business: { word: PhoneticSegment[]; meaning: string; sentence: PhoneticSegment[]; translation: string; };
  }
}

// 法语连读规则（Liaison）
interface LiaisonRule {
  name: string;
  description: string;
  pattern: string;
  examples: { text: PhoneticSegment[]; translation: string; }[];
}

// 法语鼻化元音
interface NasalVowel {
  spelling: string;
  phonetic: string;
  sound: string;
  examples: { word: PhoneticSegment[]; meaning: string; }[];
}

interface VocabItem {
  word: PhoneticSegment[];
  gender: 'm' | 'f' | 'none'; // 法语名词性别
  plural?: string;            // 复数形式
  meaning: string;
  grammar_tag: string;
  example: {
    text: PhoneticSegment[];
    translation: string;
    grammar_point: string;
  };
}

interface GrammarItem {
  point: string;
  explanation: string;
  example: {
    text: PhoneticSegment[];
    translation: string;
  };
}

interface TextItem {
  role?: string;
  name?: string;
  text: PhoneticSegment[];
  translation: string;
}

interface CourseData {
  id: string;
  groupId: string;
  topic: string;
  level: CEFRLevel;
  title: PhoneticSegment[];
  vocabulary: VocabItem[];
  grammar: GrammarItem[];
  texts: {
    dialogue: TextItem[];
    essay: { title: string; content: TextItem[] };
  };
  createdAt: number;
}

interface SRSItem {
  id: string;
  type: 'vocab' | 'grammar';
  content: any;
  srs_level: number;
  next_review: number;
}

type NotebookType = 'vocab' | 'grammar' | 'text';

interface NotebookItem {
  id: string;
  groupId: string;
  courseId?: string;
  type: NotebookType;
  dedupKey?: string;
  content: any;
  createdAt: number;
  srs_level: number;
  next_review: number;
}

// ==========================================
// 2. 高级音频服务 (TTSService)
// ==========================================
class TTSService {
  private static audioCache = new Map<string, string>();
  private static currentAudio: HTMLAudioElement | null = null;

  static stop() {
    if (this.currentAudio) {
      this.currentAudio.pause();
      this.currentAudio = null;
    }
    window.speechSynthesis.cancel();
  }

  static async play(text: string, settings: AppSettings, onEnd?: () => void) {
    this.stop();

    const cacheKey = `${settings.ttsProvider}:${text}`;
    if (this.audioCache.has(cacheKey)) {
      this.playBlob(this.audioCache.get(cacheKey)!, onEnd);
      return;
    }

    try {
      let audioBlobUrl: string | null = null;

      if (settings.ttsProvider === 'google_cloud' && settings.googleTTSKey) {
        audioBlobUrl = await this.fetchGoogleCloudTTS(text, settings.googleTTSKey);
      } else if (settings.ttsProvider === 'openai' && settings.openaiKey) {
        audioBlobUrl = await this.fetchOpenAITTS(text, settings.openaiKey);
      }

      if (audioBlobUrl) {
        this.audioCache.set(cacheKey, audioBlobUrl);
        this.playBlob(audioBlobUrl, onEnd);
      } else {
        this.playBrowserTTS(text, onEnd);
      }

    } catch (error) {
      console.error("Cloud TTS failed, using browser fallback:", error);
      this.playBrowserTTS(text, onEnd);
    }
  }

  private static playBlob(url: string, onEnd?: () => void) {
    const audio = new Audio(url);
    this.currentAudio = audio;
    audio.onended = () => {
      this.currentAudio = null;
      onEnd?.();
    };
    audio.play().catch(e => {
      console.warn("Audio play failed:", e);
      onEnd?.();
    });
  }

  private static playBrowserTTS(text: string, onEnd?: () => void) {
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'fr-FR'; // 法语
    u.rate = 0.9;
    
    const voices = window.speechSynthesis.getVoices();
    const bestVoice = voices.find(v => v.lang.includes("fr") && (v.name.includes("Google") || v.name.includes("Microsoft"))) 
                   || voices.find(v => v.lang.includes("fr"));
    
    if (bestVoice) u.voice = bestVoice;
    
    u.onend = () => onEnd?.();
    u.onerror = (e) => {
      console.error("Browser TTS error:", e);
      onEnd?.();
    };
    window.speechSynthesis.speak(u);
  }

  private static async fetchGoogleCloudTTS(text: string, key: string): Promise<string> {
    const response = await fetch(`https://texttospeech.googleapis.com/v1/text:synthesize?key=${key}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        input: { text },
        voice: { languageCode: 'fr-FR', name: 'fr-FR-Neural2-B' },
        audioConfig: { audioEncoding: 'MP3' }
      })
    });

    if (!response.ok) {
      const err = await response.json();
      throw new Error(err.error?.message || "Google TTS Error");
    }

    const data = await response.json();
    const binaryString = window.atob(data.audioContent);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    const blob = new Blob([bytes.buffer], { type: 'audio/mp3' });
    return URL.createObjectURL(blob);
  }

  private static async fetchOpenAITTS(text: string, key: string): Promise<string> {
    const response = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${key}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'tts-1',
        input: text,
        voice: 'nova'
      })
    });

    if (!response.ok) {
      const err = await response.json();
      throw new Error(err.error?.message || "OpenAI TTS Error");
    }

    const blob = await response.blob();
    return URL.createObjectURL(blob);
  }
}

// ==========================================
// 3. 静态数据处理（法语基础数据）
// ==========================================

const parseToSegments = (input: any): PhoneticSegment[] => {
  if (!input) return [];
  if (Array.isArray(input)) return input as PhoneticSegment[];
  if (typeof input !== 'string') return [{ text: String(input) }];

  const str = input;
  const segments: PhoneticSegment[] = [];

  // 匹配：word[ipa] 或 word(ipa)
  // 其它字符（空格/标点/中文等）会被保留为纯 text segment
  const re = /([A-Za-zÀ-ÿ'-]+)(?:\[([^\]]+)\]|\(([^)]+)\))?/g;

  let lastIndex = 0;
  let m: RegExpExecArray | null;

  while ((m = re.exec(str)) !== null) {
    // 先把前面的非单词部分（空格/标点）塞进去
    if (m.index > lastIndex) {
      segments.push({ text: str.slice(lastIndex, m.index) });
    }

    const word = m[1];
    const ipa = m[2] || m[3];

    segments.push(ipa ? { text: word, phonetic: ipa } : { text: word });

    lastIndex = re.lastIndex;
  }

  // 末尾残余（标点/空格等）
  if (lastIndex < str.length) {
    segments.push({ text: str.slice(lastIndex) });
  }

  // 兜底：如果什么都没解析出来，就整句返回
  return segments.length ? segments : [{ text: str }];
};


// 法语字母表数据（含音标和示例）
const RAW_ALPHABET_DATA = [
  { char: "A", name: "a", phonetic: "/a/", sound: "开口音，类似'啊'", word_l: "ami[ami]", mean_l: "朋友", sent_l: "C'est mon ami.", trans_l: "这是我的朋友。", word_b: "accord[akɔʁ]", mean_b: "协议", sent_b: "Signer un accord.", trans_b: "签署协议。" },
  { char: "B", name: "bé", phonetic: "/be/", sound: "双唇爆破音", word_l: "bonjour[bɔ̃ʒuʁ]", mean_l: "你好", sent_l: "Bonjour ! Comment ça va ?", trans_l: "你好！你好吗？", word_b: "budget[bydʒɛ]", mean_b: "预算", sent_b: "Le budget annuel.", trans_b: "年度预算。" },
  { char: "C", name: "cé", phonetic: "/se/", sound: "前接e,i时读/s/，其他读/k/", word_l: "café[kafe]", mean_l: "咖啡", sent_l: "Un café, s'il vous plaît.", trans_l: "请给我一杯咖啡。", word_b: "contrat[kɔ̃tʁa]", mean_b: "合同", sent_b: "Signer le contrat.", trans_b: "签署合同。" },
  { char: "D", name: "dé", phonetic: "/de/", sound: "舌尖爆破音", word_l: "deux[dø]", mean_l: "二", sent_l: "J'ai deux frères.", trans_l: "我有两个兄弟。", word_b: "délai[delɛ]", mean_b: "期限", sent_b: "Respecter le délai.", trans_b: "遵守期限。" },
  { char: "E", name: "e", phonetic: "/ə/", sound: "中央元音，类似'呃'", word_l: "eau[o]", mean_l: "水", sent_l: "Un verre d'eau.", trans_l: "一杯水。", word_b: "entreprise[ɑ̃tʁəpriz]", mean_b: "企业", sent_b: "Créer une entreprise.", trans_b: "创办企业。" },
  { char: "F", name: "effe", phonetic: "/ɛf/", sound: "唇齿摩擦音", word_l: "fleur[flœʁ]", mean_l: "花", sent_l: "Une belle fleur.", trans_l: "一朵漂亮的花。", word_b: "facture[faktyʁ]", mean_b: "发票", sent_b: "Payer la facture.", trans_b: "支付发票。" },
  { char: "G", name: "gé", phonetic: "/ʒe/", sound: "前接e,i时读/ʒ/，其他读/g/", word_l: "garçon[ɡaʁsɔ̃]", mean_l: "男孩", sent_l: "Le petit garçon.", trans_l: "小男孩。", word_b: "gain[ɡɛ̃]", mean_b: "收益", sent_b: "Augmenter les gains.", trans_b: "增加收益。" },
  { char: "H", name: "hache", phonetic: "/aʃ/", sound: "不发音", word_l: "hôtel[otɛl]", mean_l: "酒店", sent_l: "À l'hôtel.", trans_l: "在酒店。", word_b: "horaire[ɔʁɛʁ]", mean_b: "时间表", sent_b: "Les horaires de travail.", trans_b: "工作时间表。" },
  { char: "I", name: "i", phonetic: "/i/", sound: "闭前元音，类似'衣'", word_l: "île[il]", mean_l: "岛", sent_l: "Une île paradisiaque.", trans_l: "天堂般的岛屿。", word_b: "investissement[ɛ̃vɛstismɑ̃]", mean_b: "投资", sent_b: "Faire un investissement.", trans_b: "进行投资。" },
  { char: "J", name: "ji", phonetic: "/ʒi/", sound: "浊齿龈后擦音", word_l: "jour[ʒuʁ]", mean_l: "天", sent_l: "Bonjour !", trans_l: "你好！", word_b: "projet[pʁɔʒɛ]", mean_b: "项目", sent_b: "Lancer un projet.", trans_b: "启动项目。" },
  { char: "K", name: "ka", phonetic: "/ka/", sound: "外来词中使用", word_l: "kilo[kilo]", mean_l: "公斤", sent_l: "Un kilo de pommes.", trans_l: "一公斤苹果。", word_b: "marketing[maʁkətiŋ]", mean_b: "营销", sent_b: "Stratégie marketing.", trans_b: "营销策略。" },
  { char: "L", name: "elle", phonetic: "/ɛl/", sound: "舌尖边音", word_l: "livre[liʁv]", mean_l: "书", sent_l: "Lire un livre.", trans_l: "读书。", word_b: "licenciement[lijsɛ̃smɑ̃]", mean_b: "解雇", sent_b: "Le licenciement.", trans_b: "解雇。" },
  { char: "M", name: "emme", phonetic: "/ɛm/", sound: "双唇鼻音", word_l: "mer[mɛʁ]", mean_l: "海", sent_l: "La mer est belle.", trans_l: "大海很美。", word_b: "marché[maʁʃe]", mean_b: "市场", sent_b: "Étudier le marché.", trans_b: "研究市场。" },
  { char: "N", name: "enne", phonetic: "/ɛn/", sound: "齿龈鼻音", word_l: "nuit[nɥi]", mean_l: "夜晚", sent_l: "Cette nuit.", trans_l: "今晚。", word_b: "négociation[neɡɔsjasjɔ̃]", mean_b: "谈判", sent_b: "La négociation.", trans_b: "谈判。" },
  { char: "O", name: "o", phonetic: "/o/", sound: "闭后圆唇元音", word_l: "porte[pɔʁt]", mean_l: "门", sent_l: "Ouvrir la porte.", trans_l: "开门。", word_b: "objectif[ɔbʒɛktif]", mean_b: "目标", sent_b: "Atteindre l'objectif.", trans_b: "达成目标。" },
  { char: "P", name: "pé", phonetic: "/pe/", sound: "双唇爆破音", word_l: "pain[pɛ̃]", mean_l: "面包", sent_l: "Acheter du pain.", trans_l: "买面包。", word_b: "partenariat[paʁtənɛʁja]", mean_b: "合作", sent_b: "Un partenariat.", trans_b: "一项合作。" },
  { char: "Q", name: "qu", phonetic: "/ky/", sound: "总是与u连用，读/k/或/kw/", word_l: "quatre[katʁ]", mean_l: "四", sent_l: "Quatre personnes.", trans_l: "四个人。", word_b: "qualité[kalite]", mean_b: "质量", sent_b: "Contrôle qualité.", trans_b: "质量控制。" },
  { char: "R", name: "erre", phonetic: "/ɛʁ/", sound: "小舌擦音，法语特色", word_l: "rue[ʁy]", mean_l: "街道", sent_l: "Dans la rue.", trans_l: "在街上。", word_b: "réunion[ʁeynjɔ̃]", mean_b: "会议", sent_b: "Une réunion.", trans_b: "一场会议。" },
  { char: "S", name: "esse", phonetic: "/ɛs/", sound: "词首发/s/，两元音间读/z/", word_l: "soleil[sɔlɛj]", mean_l: "太阳", sent_l: "Le soleil brille.", trans_l: "阳光灿烂。", word_b: "stratégie[stʁateʒi]", mean_b: "战略", sent_b: "La stratégie.", trans_b: "战略。" },
  { char: "T", name: "té", phonetic: "/te/", sound: "舌尖爆破音", word_l: "table[tabl]", mean_l: "桌子", sent_l: "Sur la table.", trans_l: "在桌上。", word_b: "travail[tʁavaj]", mean_b: "工作", sent_b: "Au travail.", trans_b: "工作。" },
  { char: "U", name: "u", phonetic: "/y/", sound: "闭前圆唇元音，德语ü", word_l: "une[yn]", mean_l: "一个(阴性)", sent_l: "Une belle journée.", trans_l: "美好的一天。", word_b: "usine[yzin]", mean_b: "工厂", sent_b: "L'usine.", trans_b: "工厂。" },
  { char: "V", name: "vé", phonetic: "/ve/", sound: "唇齿摩擦音", word_l: "vin[vɛ̃]", mean_l: "葡萄酒", sent_l: "Un verre de vin.", trans_l: "一杯葡萄酒。", word_b: "vente[vɑ̃t]", mean_b: "销售", sent_b: "La vente.", trans_b: "销售。" },
  { char: "W", name: "double vé", phonetic: "/dubləve/", sound: "外来词中使用", word_l: "wagon[vaɡɔ̃]", mean_l: "车厢", sent_l: "Dans le wagon.", trans_l: "在车厢里。", word_b: "web[wɛb]", mean_b: "网络", sent_b: "Le web.", trans_b: "网络。" },
  { char: "X", name: "ixe", phonetic: "/iks/", sound: "读/ks/或/gz/", word_l: "taxi[taksi]", mean_l: "出租车", sent_l: "Prendre un taxi.", trans_l: "打车。", word_b: "expert[ɛkspɛʁ]", mean_b: "专家", sent_b: "Un expert.", trans_b: "一位专家。" },
  { char: "Y", name: "i grec", phonetic: "/iɡʁɛk/", sound: "读/i/或/j/", word_l: "yoga[jɔɡa]", mean_l: "瑜伽", sent_l: "Faire du yoga.", trans_l: "做瑜伽。", word_b: "système[sistɛm]", mean_b: "系统", sent_b: "Le système.", trans_b: "系统。" },
  { char: "Z", name: "zède", phonetic: "/zɛd/", sound: "浊齿龈擦音", word_l: "zoo[zo]", mean_l: "动物园", sent_l: "Au zoo.", trans_l: "在动物园。", word_b: "zone[zɔn]", mean_b: "区域", sent_b: "La zone.", trans_b: "区域。" }
];

// 法语鼻化元音
const NASAL_VOWELS: NasalVowel[] = [
  {
    spelling: "an, am, en, em",
    phonetic: "/ɑ̃/",
    sound: "鼻化元音，类似'昂'但鼻音",
    examples: [
      { word: parseToSegments("enfant[ɑ̃fɑ̃]"), meaning: "孩子" },
      { word: parseToSegments("dans[dɑ̃]"), meaning: "在...里" },
      { word: parseToSegments("temps[tɑ̃]"), meaning: "时间" }
    ]
  },
  {
    spelling: "in, im, ain, aim, ein",
    phonetic: "/ɛ̃/",
    sound: "鼻化元音，类似'安'但鼻音",
    examples: [
      { word: parseToSegments("vin[vɛ̃]"), meaning: "葡萄酒" },
      { word: parseToSegments("pain[pɛ̃]"), meaning: "面包" },
      { word: parseToSegments("main[mɛ̃]"), meaning: "手" }
    ]
  },
  {
    spelling: "on, om",
    phonetic: "/ɔ̃/",
    sound: "鼻化元音，类似'ong'但鼻音",
    examples: [
      { word: parseToSegments("bonjour[bɔ̃ʒuʁ]"), meaning: "你好" },
      { word: parseToSegments("nom[nɔ̃]"), meaning: "名字" },
      { word: parseToSegments("maison[mɛzɔ̃]"), meaning: "房子" }
    ]
  },
  {
    spelling: "un, um",
    phonetic: "/œ̃/",
    sound: "鼻化元音，类似'恩'但鼻音",
    examples: [
      { word: parseToSegments("un[œ̃]"), meaning: "一" },
      { word: parseToSegments("lundi[lœ̃di]"), meaning: "周一" },
      { word: parseToSegments("parfum[paʁfœ̃]"), meaning: "香水" }
    ]
  }
];

// 法语连读规则（Liaison）
const LIAISON_RULES: LiaisonRule[] = [
  {
    name: "定冠词 + 名词",
    description: "定冠词les, des与以元音或哑音h开头的名词连读",
    pattern: "les + 元音/h，des + 元音/h",
    examples: [
      { text: parseToSegments("les[le-z] amis"), translation: "朋友们（读作le-z-ami）" },
      { text: parseToSegments("des[de-z] amis"), translation: "一些朋友（读作de-z-ami）" }
    ]
  },
  {
    name: "形容词 + 名词",
    description: "以元音结尾的形容词与以元音开头的名词连读",
    pattern: "形容词元音 + 名词元音",
    examples: [
      { text: parseToSegments("petit[pəti-t] ami"), translation: "小朋友（读作pəti-t-ami）" },
      { text: parseToSegments("grand[ɡʁɑ̃-t] homme"), translation: "大人物（读作ɡʁɑ̃-t-ɔm）" }
    ]
  },
  {
    name: "代词 + 动词",
    description: "主语代词与动词之间常连读",
    pattern: "nous/vous/ils/elles + 动词",
    examples: [
      { text: parseToSegments("nous[nu-z] avons"), translation: "我们有（读作nu-z-avɔ̃）" },
      { text: parseToSegments("ils[il-z] ont"), translation: "他们有（读作il-z-ɔ̃）" }
    ]
  },
  {
    name: "est + 元音",
    description: "动词être的第三人称单数与元音开头词连读",
    pattern: "est + 元音",
    examples: [
      { text: parseToSegments("c'est[sɛ-t] un"), translation: "这是一个（读作sɛ-t-œ̃）" },
      { text: parseToSegments("il est[il-ɛ-t] à"), translation: "他在（读作il-ɛ-t-a）" }
    ]
  }
];

const getAlphabetList = (): LetterDetail[] => {
  return RAW_ALPHABET_DATA.map(item => ({
    char: item.char,
    name: item.name,
    phonetic: item.phonetic,
    sound: item.sound,
    examples: {
      lifestyle: { 
        word: parseToSegments(item.word_l), 
        meaning: item.mean_l, 
        sentence: parseToSegments(item.sent_l), 
        translation: item.trans_l 
      },
      business: { 
        word: parseToSegments(item.word_b), 
        meaning: item.mean_b, 
        sentence: parseToSegments(item.sent_b), 
        translation: item.trans_b 
      }
    }
  }));
};

// ==========================================
// 3. 服务层 (Services) - 双模数据库适配器
// ==========================================

// --- 本地存储 (Fallback) ---
class LocalStorageManager {
  static getSettings(): AppSettings {
    try {
      const stored = localStorage.getItem('francais_app_settings');
      return stored ? { ...DEFAULT_SETTINGS, ...JSON.parse(stored) } : DEFAULT_SETTINGS;
    } catch { return DEFAULT_SETTINGS; }
  }
  static saveSettings(s: AppSettings) { localStorage.setItem('francais_app_settings', JSON.stringify(s)); }

  static getDB() {
    try {
      const raw = JSON.parse(localStorage.getItem('francais_app_db') || '{}');
      return {
        courses: Array.isArray(raw.courses) ? raw.courses : [],
        srsItems: Array.isArray(raw.srsItems) ? raw.srsItems : [],
        notebookItems: Array.isArray(raw.notebookItems) ? raw.notebookItems : []
      };
    } catch {
      return { courses: [], srsItems: [], notebookItems: [] };
    }
  }
  static saveDB(db: any) { localStorage.setItem('francais_app_db', JSON.stringify(db)); }
}

// --- 数据库适配器 ---
class DBAdapter {
  static async loadSettings(user: FirebaseUser | null): Promise<AppSettings> {
    let settings = LocalStorageManager.getSettings();
    if (user && db) {
      try {
        const docRef = doc(db, 'users', user.uid, 'settings', 'general');
        const docSnap = await getDoc(docRef);
        if (docSnap.exists()) {
          const cloudSettings = docSnap.data() as AppSettings;
          settings = { ...settings, ...cloudSettings };
          LocalStorageManager.saveSettings(settings);
        }
      } catch (e) { console.error("Sync fetch failed", e); }
    }
    return settings;
  }

  static async saveSettings(user: FirebaseUser | null, settings: AppSettings) {
    LocalStorageManager.saveSettings(settings);
    if (user && db) {
      try {
        await setDoc(doc(db, 'users', user.uid, 'settings', 'general'), settings);
      } catch (e) { console.error("Cloud save failed", e); }
    }
  }

  static async archiveCourse(user: FirebaseUser | null, course: CourseData) {
    if (!user) {
      const localDB = LocalStorageManager.getDB();
      if (!localDB.courses.find((c: CourseData) => c.id === course.id)) {
        localDB.courses.push(course);
        course.vocabulary.forEach((vocab, idx) => {
          localDB.srsItems.push({
            id: `vocab-${course.id}-${idx}`, type: 'vocab', content: vocab, srs_level: 0, next_review: Date.now()
          });
        });
        LocalStorageManager.saveDB(localDB);
      }
    } else if (db) {
      const batch = writeBatch(db);
      const courseRef = doc(db, 'users', user.uid, 'courses', course.id);
      batch.set(courseRef, course);
      course.vocabulary.forEach((vocab, idx) => {
        const itemId = `vocab-${course.id}-${idx}`;
        const itemRef = doc(db, 'users', user.uid, 'srs_items', itemId);
        const srsItem: SRSItem = {
          id: itemId, type: 'vocab', content: vocab, srs_level: 0, next_review: Date.now()
        };
        batch.set(itemRef, srsItem);
      });
      await batch.commit();
    }
  }

  static async getReviewQueue(user: FirebaseUser | null): Promise<SRSItem[]> {
    const now = Date.now();
    if (!user) {
      const localDB = LocalStorageManager.getDB();
      return localDB.srsItems.filter((item: SRSItem) => item.next_review <= now);
    } else if (db) {
      const q = query(collection(db, 'users', user.uid, 'srs_items'), where("next_review", "<=", now));
      const querySnapshot = await getDocs(q);
      const items: SRSItem[] = [];
      querySnapshot.forEach((doc) => items.push(doc.data() as SRSItem));
      return items;
    }
    return [];
  }

  static async updateSRS(user: FirebaseUser | null, item: SRSItem, quality: 'hard' | 'good' | 'easy') {
    const intervals = [0, 1, 3, 7, 14, 30];
    if (quality === 'hard') item.srs_level = Math.max(0, item.srs_level - 1);
    else if (quality === 'good') item.srs_level = Math.min(5, item.srs_level + 1);
    else if (quality === 'easy') item.srs_level = Math.min(5, item.srs_level + 2);
    item.next_review = Date.now() + (intervals[item.srs_level] * 86400000);

    if (!user) {
      const localDB = LocalStorageManager.getDB();
      const idx = localDB.srsItems.findIndex((i: SRSItem) => i.id === item.id);
      if (idx !== -1) {
        localDB.srsItems[idx] = item;
        LocalStorageManager.saveDB(localDB);
      }
    } else if (db) {
      await setDoc(doc(db, 'users', user.uid, 'srs_items', item.id), item, { merge: true });
    }
  }
}

class NotebookAdapter {
  static async listAllItems(
    user: FirebaseUser | null,
    opts?: { type?: NotebookType; groupId?: string }
  ): Promise<NotebookItem[]> {
    if (!user || !db) {
      const localDB = LocalStorageManager.getDB();
      let items = (localDB.notebookItems as NotebookItem[]) || [];
      if (opts?.type) items = items.filter(it => it.type === opts.type);
      if (opts?.groupId) items = items.filter(it => it.groupId === opts.groupId);
      items.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      return items;
    }

    const snap = await getDocs(collection(db, 'users', user.uid, 'notebook_items'));
    let items: NotebookItem[] = [];
    snap.forEach(d => items.push(d.data() as NotebookItem));
    if (opts?.type) items = items.filter(it => it.type === opts.type);
    if (opts?.groupId) items = items.filter(it => it.groupId === opts.groupId);
    items.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    return items;
  }

  static async addVocabItems(
    user: FirebaseUser | null,
    groupId: string,
    courseId: string,
    vocabList: VocabItem[]
  ) {
    const now = Date.now();
    const localDB = LocalStorageManager.getDB();
    const existing = new Set<string>();
    for (const it of (localDB.notebookItems as NotebookItem[])) {
      if (it.type === 'vocab' && it.groupId === groupId && it.dedupKey) existing.add(it.dedupKey);
    }

    const toAdd: NotebookItem[] = [];
    for (const v of vocabList) {
      const dedupKey = makeVocabDedupKey(v);
      if (existing.has(dedupKey)) continue;
      existing.add(dedupKey);

      const id = makeNotebookId(groupId, 'vocab', dedupKey);
      toAdd.push({
        id,
        groupId,
        courseId,
        type: 'vocab',
        dedupKey,
        content: v,
        createdAt: now,
        srs_level: 0,
        next_review: now
      });
    }

    if (!toAdd.length) return { added: 0, skipped: vocabList.length };

    if (!user || !db) {
      localDB.notebookItems.push(...toAdd);
      LocalStorageManager.saveDB(localDB);
      return { added: toAdd.length, skipped: vocabList.length - toAdd.length };
    }

    const batch = writeBatch(db);
    for (const item of toAdd) {
      const ref = doc(db, 'users', user.uid, 'notebook_items', item.id);
      batch.set(ref, item, { merge: true });
    }
    await batch.commit();
    return { added: toAdd.length, skipped: vocabList.length - toAdd.length };
  }

  static async deleteItem(user: FirebaseUser | null, itemId: string) {
    if (!user || !db) {
      const localDB = LocalStorageManager.getDB();
      localDB.notebookItems = (localDB.notebookItems as NotebookItem[]).filter(it => it.id !== itemId);
      LocalStorageManager.saveDB(localDB);
      return;
    }
    await deleteDoc(doc(db, 'users', user.uid, 'notebook_items', itemId));
  }

  static async addGrammarItems(
    user: FirebaseUser | null,
    groupId: string,
    courseId: string,
    grammarList: GrammarItem[]
  ) {
    const now = Date.now();
    const items: NotebookItem[] = grammarList.map((g) => {
      const rawKey = `${g.point}__${JSON.stringify(g.example?.text || [])}`;
      const id = makeNotebookId(groupId, 'grammar', rawKey);
      return {
        id,
        groupId,
        courseId,
        type: 'grammar',
        content: g,
        createdAt: now,
        srs_level: 0,
        next_review: now
      };
    });

    if (!user || !db) {
      const localDB = LocalStorageManager.getDB();
      localDB.notebookItems.push(...items);
      LocalStorageManager.saveDB(localDB);
      return { added: items.length };
    }

    const batch = writeBatch(db);
    for (const item of items) {
      const ref = doc(db, 'users', user.uid, 'notebook_items', item.id);
      batch.set(ref, item, { merge: false });
    }
    await batch.commit();
    return { added: items.length };
  }

  static async addTextItems(
    user: FirebaseUser | null,
    groupId: string,
    courseId: string,
    textItems: TextItem[]
  ) {
    const now = Date.now();
    const items: NotebookItem[] = textItems.map((t) => {
      const surface = segmentsToSurface(t.text);
      const rawKey = `${surface}__${t.translation || ''}`;
      const id = makeNotebookId(groupId, 'text', rawKey);
      return {
        id,
        groupId,
        courseId,
        type: 'text',
        content: t,
        createdAt: now,
        srs_level: 0,
        next_review: now
      };
    });

    if (!user || !db) {
      const localDB = LocalStorageManager.getDB();
      localDB.notebookItems.push(...items);
      LocalStorageManager.saveDB(localDB);
      return { added: items.length };
    }

    const batch = writeBatch(db);
    for (const item of items) {
      const ref = doc(db, 'users', user.uid, 'notebook_items', item.id);
      batch.set(ref, item, { merge: false });
    }
    await batch.commit();
    return { added: items.length };
  }

  static async listGroups(user: FirebaseUser | null): Promise<{ groupId: string; count: number }[]> {
    if (!user || !db) {
      const localDB = LocalStorageManager.getDB();
      const map = new Map<string, number>();
      for (const it of (localDB.notebookItems as NotebookItem[])) {
        map.set(it.groupId, (map.get(it.groupId) || 0) + 1);
      }
      return Array.from(map.entries()).map(([groupId, count]) => ({ groupId, count }));
    }

    const snap = await getDocs(collection(db, 'users', user.uid, 'notebook_items'));
    const map = new Map<string, number>();
    snap.forEach(d => {
      const it = d.data() as NotebookItem;
      map.set(it.groupId, (map.get(it.groupId) || 0) + 1);
    });
    return Array.from(map.entries()).map(([groupId, count]) => ({ groupId, count }));
  }

  static async getReviewQueue(
    user: FirebaseUser | null,
    opts?: { type?: NotebookType; groupId?: string }
  ): Promise<NotebookItem[]> {
    const now = Date.now();

    if (!user || !db) {
      const localDB = LocalStorageManager.getDB();
      let items = (localDB.notebookItems as NotebookItem[]).filter(it => it.next_review <= now);
      if (opts?.type) items = items.filter(it => it.type === opts.type);
      if (opts?.groupId) items = items.filter(it => it.groupId === opts.groupId);
      items.sort((a, b) => a.next_review - b.next_review);
      return items;
    }

    const q1 = query(collection(db, 'users', user.uid, 'notebook_items'), where("next_review", "<=", now));
    const snap = await getDocs(q1);
    let items: NotebookItem[] = [];
    snap.forEach(d => items.push(d.data() as NotebookItem));
    if (opts?.type) items = items.filter(it => it.type === opts.type);
    if (opts?.groupId) items = items.filter(it => it.groupId === opts.groupId);
    items.sort((a, b) => a.next_review - b.next_review);
    return items;
  }

  static async updateSRS(user: FirebaseUser | null, item: NotebookItem, quality: 'hard' | 'good' | 'easy') {
    const intervals = [0, 1, 3, 7, 14, 30];
    if (quality === 'hard') item.srs_level = Math.max(0, item.srs_level - 1);
    else if (quality === 'good') item.srs_level = Math.min(5, item.srs_level + 1);
    else if (quality === 'easy') item.srs_level = Math.min(5, item.srs_level + 2);
    item.next_review = Date.now() + (intervals[item.srs_level] * 86400000);

    if (!user || !db) {
      const localDB = LocalStorageManager.getDB();
      const idx = (localDB.notebookItems as NotebookItem[]).findIndex((i: NotebookItem) => i.id === item.id);
      if (idx !== -1) {
        localDB.notebookItems[idx] = item;
        LocalStorageManager.saveDB(localDB);
      }
      return;
    }

    await setDoc(doc(db, 'users', user.uid, 'notebook_items', item.id), item, { merge: true });
  }
}

// --- AI 服务 ---
const normalizeTopic = (s: string) =>
  (s || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[^\p{L}\p{N}\s]+/gu, '');

const makeGroupId = (topic: string, level: CEFRLevel) => {
  const t = normalizeTopic(topic);
  return `${t}__${level}`;
};

const segmentsToSurface = (segs: PhoneticSegment[]) =>
  Array.isArray(segs) ? segs.map(s => s.text || '').join('') : '';

const makeVocabDedupKey = (v: VocabItem) => {
  const surface = segmentsToSurface(v.word).trim().toLowerCase();
  return surface;
};

const hashString = (input: string) => {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
};

const makeNotebookId = (groupId: string, type: NotebookType, dedupKeyOrRaw: string) => {
  return `${type}-${hashString(`${groupId}::${type}::${dedupKeyOrRaw}`)}`;
};

class AIService {
  // CEFR 等级配置（替代 JLPT）
  private static LEVEL_CONFIG = {
    A1: { vocab: 12, grammar: 3, dialogue: 6, essay: 8 },
    A2: { vocab: 15, grammar: 3, dialogue: 8, essay: 10 },
    B1: { vocab: 18, grammar: 4, dialogue: 10, essay: 12 },
    B2: { vocab: 22, grammar: 4, dialogue: 12, essay: 14 },
    C1: { vocab: 25, grammar: 5, dialogue: 14, essay: 16 },
    C2: { vocab: 30, grammar: 5, dialogue: 16, essay: 18 }
  };

  private static COURSE_PROMPT = `
You are a professional French CEFR instructor.

Task:
Create a complete, pedagogically sound French learning session about [TOPIC],
strictly following target CEFR level: [LEVEL].

==================================================
CEFR LEVEL CONTROL (CUMULATIVE, MANDATORY)
==================================================
- Higher levels INCLUDE all lower-level abilities and ADD new ones.
- Do NOT exclude lower-level grammar/vocab at higher levels.
- Do NOT introduce grammar above [LEVEL].

==================================================
PER-LEVEL DIFFICULTY CONSTRAINTS (STRICT)
==================================================

A1 (Débutant):
- Present tense only (présent de l'indicatif)
- Basic vocabulary: greetings, numbers, family, food
- Simple sentences: SVO structure
- Avoid: past tenses, future, subjunctive, complex clauses

A2 (Élémentaire):
- Includes A1, plus: passé composé, futur proche
- Basic descriptions, simple comparisons
- Avoid: subjunctive, conditional, plus-que-parfait

B1 (Seuil):
- Includes A2, plus: imparfait, futur simple, conditionnel présent
- Basic subjunctive (il faut que, je veux que)
- Longer sentences with relative clauses (qui, que, où)
- Avoid: complex subjunctive, literary tenses

B2 (Avancé):
- Includes B1, plus: plus-que-parfait, conditionnel passé
- Full subjunctive usage
- Complex sentence structures
- Abstract topics and opinions
- Avoid: literary tenses (passé simple)

C1 (Autonome):
- Includes B2, plus: nuanced expressions, idioms
- Complex argumentation
- Register variation (formal/informal)
- Literary and academic vocabulary

C2 (Maîtrise):
- All previous levels with precision and fluency
- Rare and sophisticated vocabulary
- Native-like expression

==================================================
OUTPUT SIZE (MUST FOLLOW EXACTLY)
==================================================
- Vocabulary items: EXACTLY [VOCAB_COUNT]
- Grammar points: EXACTLY [GRAMMAR_COUNT]
- Dialogue lines: EXACTLY [DIALOGUE_COUNT]
- Essay sentences: EXACTLY [ESSAY_COUNT]

==================================================
CONTENT DIVERSITY (CRITICAL)
==================================================
Dialogue and Essay MUST be meaningfully different:
1) Dialogue = spoken, turn-based, situational interaction.
2) Essay = written narrative/explanation. NOT a paraphrase of the dialogue.

==================================================
OUTPUT REQUIREMENTS (STRICT)
==================================================
- Output MUST be strict valid JSON only. No markdown, no commentary.
- Use SIMPLIFIED CHINESE ONLY for explanations/translations.
- All French text MUST use Phonetic Segment format:
  {"text":"mot","phonetic":"mo"}
- Include IPA-style phonetic notation for each word.
- For each vocabulary item, include gender (m/f/none) and plural form.

==================================================
JSON STRUCTURE
==================================================
{
  "topic": "[TOPIC]",
  "title": [PhoneticSegment...],  // CRITICAL: title MUST be in FRENCH (not Chinese), with phonetic notation
  "vocabulary": [
    {
      "id": "v1",
      "word": [...],
      "gender": "m | f | none",
      "plural": "plural form or same",
      "meaning": "chinese",
      "grammar_tag": "noun | verb | adjective | adverb | pronoun | preposition | expression",
      "example": {
        "text": [...],
        "translation": "chinese",
        "grammar_point": "concise chinese explanation"
      }
    }
  ],
  "grammar": [
    {
      "id": "g1",
      "point": "...",
      "explanation": "chinese",
      "example": {
        "text": [...],
        "translation": "chinese"
      }
    }
  ],
  "texts": {
    "dialogue": [
      {
        "id": "d1",
        "role": "A",
        "name": "...",
        "text": [...],
        "translation": "chinese"
      }
    ],
    "essay": {
      "title": "...",
      "content": [
        {
          "id": "e1",
          "text": [...],
          "translation": "chinese"
        }
      ]
    }
  }
}
`;

  private static GEMINI_PART_PROMPT = `
Role: Expert French CEFR Instructor.
You must output STRICT valid JSON only. No markdown. No extra text.
Use SIMPLIFIED CHINESE only for meanings/explanations/translations.
All French text MUST be Phonetic Segment format: {"text":"mot","phonetic":"mo"}.
Target: [TOPIC], level: [LEVEL].

Output size constraints:
- Vocabulary items: EXACTLY [VOCAB_COUNT]
- Grammar points: EXACTLY [GRAMMAR_COUNT]
- Dialogue lines: EXACTLY [DIALOGUE_COUNT]
- Essay sentences: EXACTLY [ESSAY_COUNT]

SECTION: [SECTION]
Return ONLY the JSON for this section according to the schema below.

Schemas:
1) SECTION=meta
{ "topic":"[TOPIC]", "title":[PhoneticSegment...] }  // CRITICAL: title MUST be in FRENCH, not Chinese

2) SECTION=vocabulary
{ "vocabulary":[ { "id":"v1", "word":[...], "gender":"m|f|none", "plural":"...", "meaning":"...", "grammar_tag":"...", "example":{ "text":[...], "translation":"...", "grammar_point":"..." } } ] }

3) SECTION=grammar
{ "grammar":[ { "id":"g1", "point":"...", "explanation":"...", "example":{ "text":[...], "translation":"..." } } ] }

4) SECTION=dialogue
{ "texts": { "dialogue":[ { "id":"d1", "role":"A", "name":"...", "text":[...], "translation":"..." } ] } }

5) SECTION=essay
{ "texts": { "essay": { "title":"...", "content":[ { "id":"e1", "text":[...], "translation":"..." } ] } } }

CRITICAL:
- Each SECTION must be internally complete and valid JSON.
- Respect EXACT counts for the requested section.
- Do NOT include other sections.
`;

  private static DICT_PROMPT = `
Explain French word/phrase. Output JSON.
CRITICAL: Use SIMPLIFIED CHINESE. NO ENGLISH.
Include gender for nouns, conjugation info for verbs.
Structure:
{
  "word": [{"text":"mot","phonetic":"mo"}],
  "gender": "m | f | none",
  "plural": "plural form",
  "meaning": "chinese",
  "grammar_tag": "part of speech",
  "example": { "text": [{"text":"...","phonetic":"..."}], "translation": "chinese", "grammar_point": "Detailed grammar analysis in Chinese" }
}
`;

  private static VISION_PROMPT = `
Identify main object in image. Output JSON in French.
CRITICAL: Use SIMPLIFIED CHINESE for meaning.
Structure:
{
  "word": [{"text":"mot","phonetic":"mo"}],
  "gender": "m | f | none",
  "plural": "plural form",
  "meaning": "chinese",
  "grammar_tag": "noun",
  "example": { "text": [{"text":"...","phonetic":"..."}], "translation": "chinese", "grammar_point": "usage note" }
}
`;

  private static extractJSON(text: string): string {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end === -1) return text;
    return text.substring(start, end + 1);
  }

  private static parseJSONSafe(text: string): any {
    const extracted = this.extractJSON(text)
      .replace(/\u00a0/g, ' ')
      .replace(/,\s*([}\]])/g, '$1');
    return JSON.parse(extracted);
  }

  private static normalizeSegment(segment: PhoneticSegment): PhoneticSegment {
    return segment;
  }

  private static normalizeSegments(segments: PhoneticSegment[]): PhoneticSegment[] {
    if (!Array.isArray(segments)) return [];
    return segments.map(seg => AIService.normalizeSegment(seg));
  }

  private static normalizeVocabItem(item: VocabItem): VocabItem {
    return {
      ...item,
      word: AIService.normalizeSegments(item.word),
      example: {
        ...item.example,
        text: AIService.normalizeSegments(item.example?.text || [])
      }
    };
  }

  private static normalizeGrammarItem(item: GrammarItem): GrammarItem {
    return {
      ...item,
      example: {
        ...item.example,
        text: AIService.normalizeSegments(item.example?.text || [])
      }
    };
  }

  private static normalizeTextItem(item: TextItem): TextItem {
    return {
      ...item,
      text: AIService.normalizeSegments(item.text)
    };
  }

  private static normalizeCourse(course: CourseData): CourseData {
    return {
      ...course,
      title: AIService.normalizeSegments(course.title),
      vocabulary: course.vocabulary.map(item => AIService.normalizeVocabItem(item)),
      grammar: course.grammar.map(item => AIService.normalizeGrammarItem(item)),
      texts: {
        ...course.texts,
        dialogue: course.texts.dialogue.map(item => AIService.normalizeTextItem(item)),
        essay: {
          ...course.texts.essay,
          content: course.texts.essay.content.map((item: TextItem) => AIService.normalizeTextItem(item))
        }
      }
    };
  }

  private static async requestGemini(prompt: string, settings: AppSettings, imageData?: string): Promise<string> {
    if (!settings.geminiKey) throw new Error("缺少 Gemini Key");

    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent?key=${settings.geminiKey}`;
    const parts: any[] = [{ text: prompt }];
    if (imageData) parts.push({ inlineData: { mimeType: "image/jpeg", data: imageData } });

    const doReq = async (maxOutputTokens: number) => {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts }],
          generationConfig: {
            maxOutputTokens,
            temperature: 0.7,
            responseMimeType: "application/json"
          }
        })
      });
      if (!res.ok) {
        const txt = await res.text();
        throw new Error(`Gemini HTTP ${res.status}: ${txt.slice(0, 300)}`);
      }
      const data = await res.json();
      if (data.error) throw new Error(`Gemini Error: ${data.error.message}`);
      return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    };

    try {
      return await doReq(40000);
    } catch (e: any) {
      console.warn("Gemini request failed at 40000, fallback to 20000:", e?.message || e);
      return await doReq(20000);
    }
  }

  static async callGemini(prompt: string, settings: AppSettings, imageData?: string): Promise<any> {
    const text = await this.requestGemini(prompt, settings, imageData);
    try {
      return JSON.parse(text);
    } catch (error) {
      console.warn("Gemini JSON parse error", error);
      try {
        return this.parseJSONSafe(text);
      } catch (retryError) {
        throw new Error("课程生成失败 (JSON解析错误)。请重试。");
      }
    }
  }

  static async callOpenAI(prompt: string, settings: AppSettings, imageData?: string): Promise<any> {
    if (!settings.openaiKey) throw new Error("缺少 OpenAI Key");
    const messages: any[] = [{ role: "system", content: "You are an expert French CEFR Instructor. Output strict valid JSON." }];
    if (imageData) {
      messages.push({ role: "user", content: [{ type: "text", text: prompt }, { type: "image_url", image_url: { url: `data:image/jpeg;base64,${imageData}` } }] });
    } else {
      messages.push({ role: "user", content: prompt });
    }

    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${settings.openaiKey}` },
      body: JSON.stringify({ model: "gpt-5.2", response_format: { type: "json_object" }, messages })
    });
    const data = await res.json();
    if (data.error) throw new Error(`OpenAI Error: ${data.error.message}`);
    return this.parseJSONSafe(data.choices?.[0]?.message?.content || '{}');
  }

  static async generateCourse(topic: string, level: CEFRLevel, settings: AppSettings): Promise<CourseData> {
    const config = AIService.LEVEL_CONFIG[level];

    const fill = (tpl: string, extra?: Record<string, string>) => {
      let out = tpl
        .replace(/\[TOPIC\]/g, topic)
        .replace(/\[LEVEL\]/g, level)
        .replace(/\[VOCAB_COUNT\]/g, String(config.vocab))
        .replace(/\[GRAMMAR_COUNT\]/g, String(config.grammar))
        .replace(/\[DIALOGUE_COUNT\]/g, String(config.dialogue))
        .replace(/\[ESSAY_COUNT\]/g, String(config.essay));

      if (extra) {
        for (const [k, v] of Object.entries(extra)) {
          out = out.replace(new RegExp(`\\[${k}\\]`, 'g'), v);
        }
      }
      return out;
    };

    const id = (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`);

    if (settings.selectedModel === 'gemini') {
      const part = async (section: 'meta'|'vocabulary'|'grammar'|'dialogue'|'essay') => {
        const prompt = fill(AIService.GEMINI_PART_PROMPT, { SECTION: section });
        return await AIService.callGemini(prompt, settings);
      };

      const meta = await part('meta');
      const vocab = await part('vocabulary');
      const gram = await part('grammar');
      const dial = await part('dialogue');
      const essay = await part('essay');

      const merged: any = {
        topic: meta.topic ?? topic,
        title: meta.title ?? [{ text: topic }],
        vocabulary: vocab.vocabulary ?? [],
        grammar: gram.grammar ?? [],
        texts: {
          dialogue: dial.texts?.dialogue ?? [],
          essay: essay.texts?.essay ?? { title: '', content: [] }
        }
      };
      const groupId = makeGroupId(topic, level);
      const course = { ...merged, id, groupId, createdAt: Date.now(), level };
      return AIService.normalizeCourse(course as CourseData);
    }

    const prompt = fill(AIService.COURSE_PROMPT);
    const json = await AIService.callOpenAI(prompt, settings);
    const groupId = makeGroupId(topic, level);
    const course = { ...json, id, groupId, createdAt: Date.now(), level };
    return AIService.normalizeCourse(course);
  }

  static async generateDictionary(query: string, settings: AppSettings): Promise<VocabItem> {
    const prompt = AIService.DICT_PROMPT + `\nWORD: ${query}`;
    const raw = settings.selectedModel === 'gemini' ? await AIService.callGemini(prompt, settings) : await AIService.callOpenAI(prompt, settings);

    if (typeof raw.word === 'string') {
      raw.word = [{ text: raw.word }];
    }
    if (raw.example && typeof raw.example.text === 'string') {
      raw.example.text = [{ text: raw.example.text }];
    }
    return AIService.normalizeVocabItem(raw);
  }

  static async identifyImage(base64: string, settings: AppSettings): Promise<VocabItem> {
    const raw = settings.selectedModel === 'gemini' ? await AIService.callGemini(AIService.VISION_PROMPT, settings, base64) : await AIService.callOpenAI(AIService.VISION_PROMPT, settings, base64);
    if (typeof raw.word === 'string') raw.word = [{ text: raw.word }];
    if (raw.example && typeof raw.example.text === 'string') raw.example.text = [{ text: raw.example.text }];
    return AIService.normalizeVocabItem(raw);
  }
}


// ==========================================
// 4. UI 组件
// ==========================================

// 音标文本组件（替代日语振假名组件）
const PhoneticText: React.FC<{ segments: PhoneticSegment[]; className?: string; showPhonetic?: boolean }> = ({ 
  segments, 
  className = "",
  showPhonetic = true
}) => {
  if (!segments) return null;
  const safeSegments = Array.isArray(segments) ? segments : [];
  return (
    <span className={`inline-flex flex-wrap items-baseline gap-x-0.5 leading-loose ${className}`}>
      {safeSegments.map((seg, idx) => (
        <React.Fragment key={idx}>
          {seg.phonetic && showPhonetic ? (
            <ruby className="group cursor-default font-normal">
              {seg.text}
              <rt className="text-[0.55em] text-indigo-500 font-normal select-none group-hover:text-indigo-700 transition-colors">
                {seg.phonetic}
              </rt>
            </ruby>
          ) : (
            <span>{seg.text}</span>
          )}
        </React.Fragment>
      ))}
    </span>
  );
};

// 播放按钮组件
const PlayButton: React.FC<{ text: string | PhoneticSegment[]; size?: 'sm' | 'md' | 'lg' }> = ({ text, size = 'md' }) => {
  const [isPlaying, setIsPlaying] = useState(false);
  const settings = useContext(SettingsContext);

  const getTextString = () => {
    if (typeof text === 'string') return text;
    if (Array.isArray(text)) return text.map(s => s.text).join('');
    return "";
  };

  const handlePlay = (e: React.MouseEvent) => {
    e.stopPropagation();
    const str = getTextString();
    if (!str) return;

    setIsPlaying(true);
    TTSService.play(str, settings, () => setIsPlaying(false));
  };

  const sizeClasses = { sm: "w-6 h-6", md: "w-8 h-8", lg: "w-12 h-12" };
  const iconSizes = { sm: 12, md: 16, lg: 24 };
  return (
    <button onClick={handlePlay} className={`${sizeClasses[size]} rounded-full flex items-center justify-center bg-indigo-50 text-indigo-600 hover:bg-indigo-100 ${isPlaying ? 'animate-pulse ring-2 ring-indigo-300' : ''}`}>
      <Volume2 size={iconSizes[size]} />
    </button>
  );
};

// 文章朗读组件
const EssayPlayer: React.FC<{ segments: TextItem[] }> = ({ segments }) => {
  const [status, setStatus] = useState<'idle' | 'playing'>('idle');
  const settings = useContext(SettingsContext);
  const fullText = useMemo(() => segments.map(s => s.text.map(t => t.text).join('')).join('. '), [segments]);

  const togglePlay = () => {
    if (status === 'playing') {
      TTSService.stop();
      setStatus('idle');
    } else {
      setStatus('playing');
      TTSService.play(fullText, settings, () => setStatus('idle'));
    }
  };

  return (
    <button onClick={togglePlay} className="flex items-center gap-2 bg-indigo-100 text-indigo-700 px-4 py-2 rounded-full font-bold hover:bg-indigo-200 transition-colors">
      {status === 'playing' ? <Pause size={16} /> : <Play size={16} />}
      {status === 'playing' ? '停止' : '全文朗读'}
    </button>
  );
};

// 认证弹窗
const AuthModal: React.FC<{ isOpen: boolean; onClose: () => void }> = ({ isOpen, onClose }) => {
  const [isLogin, setIsLogin] = useState(true);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleAuth = async () => {
    if (!auth) { setError("Firebase 未配置"); return; }
    setLoading(true); setError("");
    try {
      if (typeof __initial_auth_token !== 'undefined' && __initial_auth_token) {
        await signInWithCustomToken(auth, __initial_auth_token);
      } else {
        if (isLogin) await signInWithEmailAndPassword(auth, email, password);
        else await createUserWithEmailAndPassword(auth, email, password);
      }
      onClose();
    } catch (e: any) { setError(e.message); }
    finally { setLoading(false); }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4 animate-in fade-in">
      <div className="bg-white w-full max-w-sm rounded-3xl p-8 shadow-2xl relative">
        <button onClick={onClose} className="absolute top-4 right-4 text-gray-400 hover:text-gray-600"><X size={20} /></button>
        <h2 className="text-2xl font-bold text-gray-900 mb-2">{isLogin ? "欢迎回来" : "创建账号"}</h2>
        <div className="space-y-4">
          <input type="email" placeholder="邮箱" value={email} onChange={e => setEmail(e.target.value)} className="w-full px-4 py-3 rounded-xl border border-gray-200 focus:border-indigo-500 outline-none" />
          <input type="password" placeholder="密码" value={password} onChange={e => setPassword(e.target.value)} className="w-full px-4 py-3 rounded-xl border border-gray-200 focus:border-indigo-500 outline-none" />
          {error && <div className="text-red-500 text-xs">{error}</div>}
          <button onClick={handleAuth} disabled={loading} className="w-full bg-gray-900 text-white py-3 rounded-xl font-bold hover:bg-gray-800 flex justify-center">
            {loading ? <RefreshCw className="animate-spin" /> : (isLogin ? "登录" : "注册")}
          </button>
          <div className="text-center text-sm text-gray-500 cursor-pointer hover:text-indigo-600" onClick={() => setIsLogin(!isLogin)}>{isLogin ? "没有账号? 去注册" : "已有账号? 去登录"}</div>
        </div>
      </div>
    </div>
  );
};

// ==========================================
// 5. 主视图组件
// ==========================================

// 基础学习视图（法语字母表 + 发音规则）
const FoundationView: React.FC = () => {
  const [activeTab, setActiveTab] = useState<'alphabet' | 'nasal' | 'liaison'>('alphabet');
  const [selectedLetter, setSelectedLetter] = useState<LetterDetail | null>(null);
  const [contextTab, setContextTab] = useState<'lifestyle' | 'business'>('lifestyle');
  const alphabetList = useMemo(() => getAlphabetList(), []);

  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      <div className="flex justify-between items-end">
        <div>
          <h2 className="text-3xl font-bold text-gray-900">法语基础</h2>
          <p className="text-gray-500">掌握法语字母、鼻化元音和连读规则</p>
        </div>
        <div className="flex bg-gray-200 p-1 rounded-lg">
          <button onClick={() => setActiveTab('alphabet')} className={`px-3 py-1 text-sm font-bold rounded-md ${activeTab === 'alphabet' ? 'bg-white shadow-sm' : 'text-gray-500'}`}>字母表</button>
          <button onClick={() => setActiveTab('nasal')} className={`px-3 py-1 text-sm font-bold rounded-md ${activeTab === 'nasal' ? 'bg-white shadow-sm' : 'text-gray-500'}`}>鼻化元音</button>
          <button onClick={() => setActiveTab('liaison')} className={`px-3 py-1 text-sm font-bold rounded-md ${activeTab === 'liaison' ? 'bg-white shadow-sm' : 'text-gray-500'}`}>连读</button>
        </div>
      </div>

      {activeTab === 'alphabet' && (
        <>
          <div className="grid grid-cols-5 md:grid-cols-7 gap-2">
            {alphabetList.map((letter, i) => (
              <button 
                key={i} 
                onClick={() => setSelectedLetter(letter)} 
                className="aspect-square bg-white rounded-xl border border-gray-100 shadow-sm flex flex-col items-center justify-center hover:text-indigo-600 hover:shadow-md transition-all group"
              >
                <span className="text-2xl font-bold text-gray-800 group-hover:text-indigo-600">{letter.char}</span>
                <span className="text-[10px] text-gray-400">{letter.phonetic}</span>
              </button>
            ))}
          </div>

          {selectedLetter && (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4 animate-in fade-in">
              <div className="bg-white w-full max-w-2xl rounded-3xl overflow-hidden shadow-2xl relative animate-in zoom-in-95">
                <div className="bg-gray-50 px-6 py-4 flex justify-between items-center border-b border-gray-100">
                  <h3 className="font-bold text-gray-500">字母详情</h3>
                  <button onClick={() => setSelectedLetter(null)} className="p-1 hover:bg-gray-200 rounded-full"><X size={20} /></button>
                </div>
                <div className="p-8 flex flex-col md:flex-row gap-8">
                  <div className="flex flex-col items-center shrink-0 w-full md:w-40">
                    <div className="w-32 h-32 bg-indigo-600 text-white rounded-3xl flex items-center justify-center text-7xl font-bold shadow-lg shadow-indigo-200 mb-4">
                      {selectedLetter.char}
                    </div>
                    <PlayButton text={selectedLetter.char} size="lg" />
                    <div className="mt-4 text-center">
                      <span className="text-xs font-bold text-gray-400 uppercase">字母名</span>
                      <p className="text-lg font-bold text-indigo-600">{selectedLetter.name}</p>
                      <p className="text-sm text-gray-500">{selectedLetter.phonetic}</p>
                    </div>
                    <div className="mt-4 text-center">
                      <span className="text-xs font-bold text-gray-400 uppercase">发音提示</span>
                      <p className="text-sm text-gray-600 mt-1">{selectedLetter.sound}</p>
                    </div>
                  </div>
                  <div className="flex-1 space-y-4">
                    <div className="flex bg-gray-100 p-1 rounded-xl">
                      <button onClick={() => setContextTab('lifestyle')} className={`flex-1 py-2 rounded-lg text-sm font-bold flex items-center justify-center gap-2 ${contextTab === 'lifestyle' ? 'bg-white shadow-sm text-indigo-600' : 'text-gray-500'}`}><Coffee size={16} /> 生活场景</button>
                      <button onClick={() => setContextTab('business')} className={`flex-1 py-2 rounded-lg text-sm font-bold flex items-center justify-center gap-2 ${contextTab === 'business' ? 'bg-white shadow-sm text-blue-700' : 'text-gray-500'}`}><Briefcase size={16} /> 商务场景</button>
                    </div>
                    <div className="bg-white border border-gray-100 rounded-2xl p-6 shadow-sm">
                      <div className="mb-6">
                        <div className="text-xs text-gray-400 font-bold uppercase mb-1">单词</div>
                        <div className="flex justify-between items-center">
                          <div>
                            <div className="text-2xl font-bold text-gray-900">
                              <PhoneticText segments={selectedLetter.examples[contextTab].word} />
                            </div>
                            <div className="text-sm text-gray-500">{selectedLetter.examples[contextTab].meaning}</div>
                          </div>
                          <PlayButton text={selectedLetter.examples[contextTab].word} size="md" />
                        </div>
                      </div>
                      <div className="pt-4 border-t border-gray-100">
                        <div className="text-xs text-gray-400 font-bold uppercase mb-2">例句</div>
                        <div className="flex gap-3 items-start">
                          <PlayButton text={selectedLetter.examples[contextTab].sentence} size="sm" />
                          <div>
                            <PhoneticText segments={selectedLetter.examples[contextTab].sentence} className="text-base text-gray-800 font-medium" />
                            <div className="text-xs text-gray-400 mt-1">{selectedLetter.examples[contextTab].translation}</div>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}
        </>
      )}

      {activeTab === 'nasal' && (
        <div className="space-y-6">
          <p className="text-gray-600">法语鼻化元音是法语发音的重要特色，通过鼻腔共鸣发出。</p>
          <div className="grid md:grid-cols-2 gap-4">
            {NASAL_VOWELS.map((vowel, i) => (
              <div key={i} className="bg-white p-6 rounded-2xl border border-gray-100 shadow-sm">
                <div className="flex items-center gap-3 mb-4">
                  <div className="w-16 h-16 bg-indigo-100 rounded-xl flex items-center justify-center">
                    <span className="text-2xl font-bold text-indigo-600">{vowel.phonetic}</span>
                  </div>
                  <div>
                    <div className="text-sm text-gray-400">拼写形式</div>
                    <div className="font-bold text-gray-800">{vowel.spelling}</div>
                    <div className="text-sm text-gray-500">{vowel.sound}</div>
                  </div>
                </div>
                <div className="space-y-2">
                  {vowel.examples.map((ex, j) => (
                    <div key={j} className="flex items-center justify-between bg-gray-50 p-2 rounded-lg">
                      <div className="flex items-center gap-2">
                        <PhoneticText segments={ex.word} />
                        <span className="text-sm text-gray-500">{ex.meaning}</span>
                      </div>
                      <PlayButton text={ex.word} size="sm" />
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {activeTab === 'liaison' && (
        <div className="space-y-6">
          <p className="text-gray-600">连读（Liaison）是法语的重要特征，指前一个词结尾的辅音与后一个词开头的元音连读。</p>
          <div className="space-y-4">
            {LIAISON_RULES.map((rule, i) => (
              <div key={i} className="bg-white p-6 rounded-2xl border border-gray-100 shadow-sm">
                <div className="flex items-center gap-2 mb-2">
                  <Music size={18} className="text-indigo-600" />
                  <h4 className="font-bold text-gray-800">{rule.name}</h4>
                </div>
                <p className="text-sm text-gray-600 mb-2">{rule.description}</p>
                <div className="text-xs text-indigo-600 bg-indigo-50 inline-block px-2 py-1 rounded mb-3">{rule.pattern}</div>
                <div className="grid md:grid-cols-2 gap-3">
                  {rule.examples.map((ex, j) => (
                    <div key={j} className="bg-gray-50 p-3 rounded-lg">
                      <div className="flex items-center gap-2 mb-1">
                        <PhoneticText segments={ex.text} />
                        <PlayButton text={ex.text} size="sm" />
                      </div>
                      <div className="text-xs text-gray-500">{ex.translation}</div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};


// 课程生成视图
const CourseGeneratorView: React.FC<any> = ({ settings, user, topic, setTopic, loading, setLoading, errorMsg, setErrorMsg, course, setCourse }) => {
  const [level, setLevel] = useState<CEFRLevel>('A1');
  const [selectedVocab, setSelectedVocab] = useState<VocabItem | null>(null);
  const [isSaved, setIsSaved] = useState(false);
  const [notebookMsg, setNotebookMsg] = useState<string>("");

  const handleGenerate = async () => {
    if (!topic) return;
    setLoading(true); setCourse(null); setErrorMsg("");
    try {
      const data = await AIService.generateCourse(topic, level, settings);
      setCourse(data); setIsSaved(false);
    } catch (e: any) { setErrorMsg(e.message || "未知错误"); }
    finally { setLoading(false); }
  };

  const handleSave = async () => {
    if (course) { await DBAdapter.archiveCourse(user, course); setIsSaved(true); }
  };

  const ensureCourse = () => {
    if (!course) throw new Error("课程为空");
    if (!course.groupId) throw new Error("缺少 groupId");
    return course;
  };

  const addVocabToNotebook = async (items: VocabItem[]) => {
    const c = ensureCourse();
    const res = await NotebookAdapter.addVocabItems(user, c.groupId, c.id, items);
    setNotebookMsg(`单词本：新增 ${res.added}，跳过重复 ${res.skipped}`);
    setTimeout(() => setNotebookMsg(""), 2500);
  };

  const addGrammarToNotebook = async (items: GrammarItem[]) => {
    const c = ensureCourse();
    const res = await NotebookAdapter.addGrammarItems(user, c.groupId, c.id, items);
    setNotebookMsg(`语法本：已添加 ${res.added}`);
    setTimeout(() => setNotebookMsg(""), 2500);
  };

  const addTextToNotebook = async (items: TextItem[]) => {
    const c = ensureCourse();
    const res = await NotebookAdapter.addTextItems(user, c.groupId, c.id, items);
    setNotebookMsg(`课文本：已添加 ${res.added}`);
    setTimeout(() => setNotebookMsg(""), 2500);
  };

  return (
    <div className="space-y-8 pb-20 animate-in fade-in duration-500">
      {notebookMsg && (
        <div className="max-w-xl mx-auto text-center text-sm bg-emerald-50 border border-emerald-200 text-emerald-700 px-4 py-2 rounded-xl">
          {notebookMsg}
        </div>
      )}

      <div className="text-center space-y-6 pt-10">
        <h2 className="text-3xl font-bold text-gray-900">今天想学什么？</h2>
        <div className="flex flex-col gap-4 max-w-xl mx-auto">
          <div className="flex items-center gap-2 bg-white p-2 rounded-2xl shadow-sm border border-gray-200">
            <input
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              placeholder="例如: 在餐厅点餐, 商务会议, 购物..."
              className="flex-1 px-4 py-2 bg-transparent outline-none text-lg"
              onKeyDown={(e) => e.key === "Enter" && handleGenerate()}
            />
            <button
              onClick={handleGenerate}
              disabled={loading}
              className="bg-gray-900 text-white px-6 py-3 rounded-xl font-bold flex items-center gap-2 hover:bg-gray-800 disabled:opacity-50 transition-all"
            >
              {loading ? <RefreshCw className="animate-spin" /> : <Brain size={20} />} 生成课程
            </button>
          </div>

          <div className="flex justify-center gap-2 flex-wrap">
            {(["A1", "A2", "B1", "B2", "C1", "C2"] as CEFRLevel[]).map((lvl) => (
              <button
                key={lvl}
                onClick={() => setLevel(lvl)}
                className={`px-4 py-1.5 rounded-full text-sm font-bold transition-all ${
                  level === lvl ? "bg-indigo-600 text-white shadow-md" : "bg-white text-gray-400 hover:bg-gray-50"
                }`}
              >
                {lvl}
              </button>
            ))}
          </div>
        </div>

        <div className="flex justify-center gap-2 text-xs text-gray-400">
          <span>模型: {settings.selectedModel === "gemini" ? "⚡ Gemini Flash" : "🧠 GPT-5.2"}</span>
        </div>

        {errorMsg && <div className="text-red-600 text-sm bg-red-50 p-2 rounded">{errorMsg}</div>}
      </div>

      {course && (
        <div className="space-y-12 animate-in slide-in-from-bottom-8 duration-700">
          <div className="text-center border-b border-gray-200 pb-6">
            <span className="text-xs font-bold text-indigo-600 tracking-widest uppercase">AI 课程 ({level})</span>
            <div className="text-4xl font-bold text-gray-900 mt-2 mb-2 flex justify-center gap-3">
              <PhoneticText segments={course.title} />
              <PlayButton text={course.title} size="lg" />
            </div>
            <p className="text-gray-500">{course.topic}</p>
          </div>

          {/* 词汇 */}
          <section>
            <div className="flex items-center justify-between mb-6">
              <h3 className="text-xl font-bold text-gray-800 flex items-center gap-2">
                <div className="w-1 h-6 bg-indigo-500 rounded-full" /> 核心词汇
              </h3>
              <button
                onClick={() => addVocabToNotebook(course.vocabulary)}
                className="text-xs font-bold bg-indigo-50 text-indigo-700 px-3 py-2 rounded-full hover:bg-indigo-100"
              >
                整表加入单词本
              </button>
            </div>

            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              {course.vocabulary.map((vocab: any, i: number) => (
                <button
                  key={i}
                  onClick={() => setSelectedVocab(vocab)}
                  className="bg-white p-4 rounded-2xl border border-gray-100 shadow-sm hover:shadow-md hover:border-indigo-200 transition-all text-left group"
                >
                  <div className="flex items-center gap-2 mb-1">
                    <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${vocab.gender === 'm' ? 'bg-blue-100 text-blue-700' : vocab.gender === 'f' ? 'bg-pink-100 text-pink-700' : 'bg-gray-100 text-gray-600'}`}>
                      {vocab.gender === 'm' ? 'm' : vocab.gender === 'f' ? 'f' : '-'}
                    </span>
                  </div>
                  <div className="text-lg font-bold text-gray-800 mb-1 group-hover:text-indigo-600">
                    <PhoneticText segments={vocab.word} showPhonetic={false} />
                  </div>
                  <div className="text-xs text-gray-400 truncate">{vocab.meaning}</div>
                </button>
              ))}
            </div>
          </section>

          {/* 语法 */}
          <section>
            <div className="flex items-center justify-between mb-6">
              <h3 className="text-xl font-bold text-gray-800 flex items-center gap-2">
                <div className="w-1 h-6 bg-pink-500 rounded-full" /> 关键语法
              </h3>
              <button
                onClick={() => addGrammarToNotebook(course.grammar)}
                className="text-xs font-bold bg-pink-50 text-pink-700 px-3 py-2 rounded-full hover:bg-pink-100"
              >
                整段加入语法本
              </button>
            </div>

            <div className="space-y-4">
              {course.grammar.map((g: any, i: number) => (
                <div key={i} className="bg-white p-6 rounded-2xl border border-gray-100 shadow-sm">
                  <div className="flex items-center justify-between mb-2">
                    <div className="font-bold text-lg text-indigo-600">{g.point}</div>
                    <button
                      onClick={() => addGrammarToNotebook([g])}
                      className="text-xs font-bold bg-gray-100 text-gray-700 px-3 py-1.5 rounded-full hover:bg-gray-200"
                    >
                      加入语法本
                    </button>
                  </div>

                  <p className="text-sm text-gray-600 mb-4">{g.explanation}</p>

                  <div className="bg-gray-50 p-3 rounded-xl flex gap-3 items-start">
                    <PlayButton text={g.example.text} size="sm" />
                    <div>
                      <PhoneticText segments={g.example.text} />
                      <div className="text-xs text-gray-400 mt-1">{g.example.translation}</div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </section>

          {/* 对话与短文 */}
          <section>
            <h3 className="text-xl font-bold text-gray-800 mb-6 flex items-center gap-2">
              <div className="w-1 h-6 bg-emerald-500 rounded-full" /> 对话与短文
            </h3>

            <div className="grid md:grid-cols-2 gap-6">
              {/* 左：对话 */}
              <div className="bg-white p-6 rounded-3xl border border-gray-100 shadow-sm space-y-4">
                <div className="flex items-center justify-between mb-4">
                  <h4 className="font-bold text-gray-400 text-xs uppercase">场景对话</h4>
                  <button
                    onClick={() => addTextToNotebook(course.texts.dialogue)}
                    className="text-xs font-bold bg-emerald-50 text-emerald-700 px-3 py-2 rounded-full hover:bg-emerald-100"
                  >
                    对话全加入课文本
                  </button>
                </div>

                {course.texts.dialogue.map((line: any, i: number) => (
                  <div key={i} className="flex gap-3">
                    <div className="w-8 h-8 rounded-full bg-gray-100 flex items-center justify-center text-xs font-bold text-gray-500 shrink-0">
                      {line.role}
                    </div>

                    <div className="flex-1">
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <div className="flex items-center gap-2">
                            <PlayButton text={line.text} size="sm" />
                            <PhoneticText segments={line.text} className="text-lg font-medium" />
                          </div>
                          <p className="text-sm text-gray-400 pl-8">{line.translation}</p>
                        </div>

                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            addTextToNotebook([line]);
                          }}
                          className="text-[11px] font-bold bg-gray-100 text-gray-700 px-3 py-1.5 rounded-full hover:bg-gray-200 shrink-0"
                        >
                          加入
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>

              {/* 右：短文 */}
              <div className="bg-white p-6 rounded-3xl border border-gray-100 shadow-sm">
                <div className="flex justify-between items-center mb-4 gap-2">
                  <h4 className="font-bold text-gray-400 text-xs uppercase">{course.texts.essay.title}</h4>

                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => addTextToNotebook(course.texts.essay.content)}
                      className="text-xs font-bold bg-emerald-50 text-emerald-700 px-3 py-2 rounded-full hover:bg-emerald-100"
                    >
                      短文全加入课文本
                    </button>
                    <EssayPlayer segments={course.texts.essay.content} />
                  </div>
                </div>

                <div className="space-y-6">
                  {course.texts.essay.content.map((sent: any, i: number) => (
                    <div key={i} className="group cursor-pointer hover:bg-gray-50 rounded-lg p-2 -mx-2 transition-colors">
                      <div className="flex gap-3 items-start justify-between">
                        <div className="flex gap-3 items-start">
                          <PlayButton text={sent.text} size="sm" />
                          <div>
                            <PhoneticText segments={sent.text} className="text-lg text-gray-800 leading-8" />
                            <div className="text-sm text-gray-500 mt-1 border-t border-gray-100 pt-1">{sent.translation}</div>
                          </div>
                        </div>

                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            addTextToNotebook([sent]);
                          }}
                          className="text-[11px] font-bold bg-gray-100 text-gray-700 px-3 py-1.5 rounded-full hover:bg-gray-200 shrink-0"
                        >
                          加入
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </section>

          <div className="flex justify-center pb-10">
            <button
              onClick={handleSave}
              disabled={isSaved}
              className={`px-8 py-4 rounded-full font-bold flex items-center gap-2 transition-all shadow-lg ${
                isSaved ? "bg-green-100 text-green-700" : "bg-gray-900 text-white hover:scale-105"
              }`}
            >
              {isSaved ? <CheckCircle size={20} /> : <Save size={20} />} {isSaved ? "已归档" : "完成并归档"}
            </button>
          </div>
        </div>
      )}

      {/* 词汇详情弹窗 */}
      {selectedVocab && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4 animate-in fade-in">
          <div className="bg-white w-full max-w-lg rounded-3xl p-8 shadow-2xl relative animate-in zoom-in-95 duration-200">
            <button
              onClick={() => setSelectedVocab(null)}
              className="absolute top-4 right-4 p-2 bg-gray-100 rounded-full hover:bg-gray-200"
            >
              <X size={20} />
            </button>

            <div className="flex flex-col items-center text-center space-y-4">
              <div className="flex items-center gap-2">
                <span className="text-xs font-bold bg-indigo-50 text-indigo-600 px-3 py-1 rounded-full uppercase tracking-wider">
                  {selectedVocab.grammar_tag}
                </span>
                <span className={`text-xs font-bold px-2 py-1 rounded-full ${selectedVocab.gender === 'm' ? 'bg-blue-100 text-blue-700' : selectedVocab.gender === 'f' ? 'bg-pink-100 text-pink-700' : 'bg-gray-100 text-gray-600'}`}>
                  {selectedVocab.gender === 'm' ? '阳性' : selectedVocab.gender === 'f' ? '阴性' : '-'}
                </span>
              </div>

              <div className="text-5xl font-bold text-gray-900 mb-2">
                <PhoneticText segments={selectedVocab.word} />
              </div>

              {selectedVocab.plural && selectedVocab.plural !== 'same' && (
                <div className="text-sm text-gray-500">复数: {selectedVocab.plural}</div>
              )}

              <PlayButton text={selectedVocab.word} size="lg" />

              <p className="text-xl text-gray-600 font-medium">{selectedVocab.meaning}</p>

              <div className="w-full bg-gray-50 rounded-2xl p-6 mt-6 text-left">
                <div className="text-xs text-gray-400 font-bold uppercase mb-3">例句</div>

                <div className="flex gap-3 items-start mb-2">
                  <PlayButton text={selectedVocab.example.text} size="sm" />
                  <PhoneticText segments={selectedVocab.example.text} className="text-lg font-medium text-gray-800" />
                </div>

                <p className="text-sm text-gray-500 pl-9">{selectedVocab.example.translation}</p>

                {selectedVocab.example.grammar_point && (
                  <div className="mt-4 pt-3 border-t border-gray-200/50">
                    <div className="flex gap-2 items-center mb-1">
                      <Brain size={14} className="text-pink-500" />
                      <span className="text-xs font-bold text-gray-400 uppercase">语法深度解析</span>
                    </div>
                    <p className="text-sm text-gray-700 leading-relaxed pl-6">{selectedVocab.example.grammar_point}</p>
                  </div>
                )}
              </div>

              <button
                onClick={() => addVocabToNotebook([selectedVocab])}
                className="w-full bg-indigo-600 text-white py-3 rounded-xl font-bold hover:bg-indigo-700 mt-2"
              >
                加入单词本（自动去重）
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};


// 复习中心视图
const ReviewCenterView: React.FC<{ user: FirebaseUser | null }> = ({ user }) => {
  const [items, setItems] = useState<NotebookItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [filterType, setFilterType] = useState<NotebookType | 'all'>('all');
  const [selected, setSelected] = useState<NotebookItem | null>(null);

  const refresh = async () => {
    setLoading(true);
    try {
      const list = await NotebookAdapter.listAllItems(user);
      setItems(list);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh();
  }, [user]);

  const filtered = items.filter(it => (filterType === 'all' ? true : it.type === filterType));

  const getTitle = (it: NotebookItem) => {
    if (it.type === 'vocab') return (it.content as VocabItem).word?.map(s => s.text).join('') || '';
    if (it.type === 'grammar') return (it.content as GrammarItem).point || '';
    return (it.content as TextItem).text?.map(s => s.text).join('') || '';
  };

  const getSub = (it: NotebookItem) => {
    if (it.type === 'vocab') return (it.content as VocabItem).meaning || '';
    if (it.type === 'grammar') return (it.content as GrammarItem).explanation || '';
    return (it.content as TextItem).translation || '';
  };

  const getBadge = (it: NotebookItem) =>
    it.type === 'vocab' ? '单词' : it.type === 'grammar' ? '语法' : '课文';

  const getGenderBadge = (it: NotebookItem) => {
    if (it.type !== 'vocab') return null;
    const gender = (it.content as VocabItem).gender;
    return gender === 'm' ? '阳性' : gender === 'f' ? '阴性' : null;
  };

  return (
    <div className="max-w-4xl mx-auto pt-6 space-y-6 animate-in fade-in">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h2 className="text-3xl font-bold text-gray-900">生词本中心</h2>
          <p className="text-gray-500">你加过的单词 / 语法 / 课文都在这里。想删就删，主打一个自由。</p>
        </div>

        <button
          onClick={refresh}
          className="px-4 py-2 rounded-xl bg-gray-900 text-white font-bold text-sm hover:bg-gray-800 flex items-center gap-2"
        >
          <RefreshCw size={16} className={loading ? "animate-spin" : ""} />
          刷新
        </button>
      </div>

      <div className="flex flex-wrap gap-2">
        {(['all', 'vocab', 'grammar', 'text'] as const).map(t => (
          <button
            key={t}
            onClick={() => setFilterType(t as any)}
            className={`px-4 py-2 rounded-full text-sm font-bold border transition-all ${
              filterType === t
                ? 'bg-indigo-600 text-white border-indigo-600 shadow-sm'
                : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'
            }`}
          >
            {t === 'all' ? '全部' : t === 'vocab' ? '单词' : t === 'grammar' ? '语法' : '课文'}
            <span className="ml-2 text-xs opacity-80">
              {t === 'all'
                ? items.length
                : items.filter(it => it.type === t).length}
            </span>
          </button>
        ))}
      </div>

      <div className="bg-white border border-gray-100 rounded-3xl shadow-sm overflow-hidden">
        {filtered.length === 0 ? (
          <div className="p-12 text-center text-gray-500">
            {filterType === 'all' ? '还没有内容。去课程页点"加入单词本/语法本/课文本"。' : '这个分类还没有内容。'}
          </div>
        ) : (
          <div className="divide-y divide-gray-100">
            {filtered.map(it => (
              <div key={it.id} className="p-5 flex items-start justify-between gap-4">
                <div className="min-w-0 cursor-pointer" onClick={() => setSelected(it)}>
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-[11px] font-bold bg-gray-100 text-gray-600 px-2 py-1 rounded-full">
                      {getBadge(it)}
                    </span>
                    {getGenderBadge(it) && (
                      <span className={`text-[11px] font-bold px-2 py-1 rounded-full ${(it.content as VocabItem).gender === 'm' ? 'bg-blue-100 text-blue-700' : 'bg-pink-100 text-pink-700'}`}>
                        {getGenderBadge(it)}
                      </span>
                    )}
                    <span className="text-xs text-gray-400">{it.groupId}</span>
                  </div>
                  <div className="font-bold text-gray-900 truncate">{getTitle(it)}</div>
                  <div className="text-sm text-gray-500 line-clamp-2 mt-1">{getSub(it)}</div>
                </div>

                <div className="flex gap-2 shrink-0">
                  <button
                    onClick={async () => {
                      await NotebookAdapter.deleteItem(user, it.id);
                      await refresh();
                    }}
                    className="px-3 py-2 rounded-xl bg-red-50 text-red-600 font-bold text-xs hover:bg-red-100"
                  >
                    删除
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 详情弹窗 */}
      {selected && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4 animate-in fade-in">
          <div className="bg-white w-full max-w-2xl rounded-3xl p-8 shadow-2xl relative animate-in zoom-in-95 duration-200">
            <button
              onClick={() => setSelected(null)}
              className="absolute top-4 right-4 p-2 bg-gray-100 rounded-full hover:bg-gray-200"
            >
              <X size={20} />
            </button>

            <div className="flex items-center justify-between gap-4 mb-6">
              <div>
                <div className="text-xs font-bold text-gray-400 uppercase mb-2">{getBadge(selected)}</div>
                <div className="text-3xl font-black text-gray-900 break-words">{getTitle(selected)}</div>
                <div className="text-gray-500 mt-2 break-words">{getSub(selected)}</div>
                <div className="text-xs text-gray-400 mt-2">{selected.groupId}</div>
              </div>

              <button
                onClick={async () => {
                  await NotebookAdapter.deleteItem(user, selected.id);
                  setSelected(null);
                  await refresh();
                }}
                className="px-4 py-3 rounded-2xl bg-red-50 text-red-600 font-bold hover:bg-red-100"
              >
                删除此条
              </button>
            </div>

            {selected.type === 'vocab' && (
              <div className="bg-gray-50 rounded-2xl p-6 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="font-bold text-gray-900 text-xl">
                    <PhoneticText segments={(selected.content as VocabItem).word} />
                  </div>
                  <PlayButton text={(selected.content as VocabItem).word} size="md" />
                </div>
                <div className="flex items-center gap-2">
                  <span className={`text-xs font-bold px-2 py-1 rounded-full ${(selected.content as VocabItem).gender === 'm' ? 'bg-blue-100 text-blue-700' : 'bg-pink-100 text-pink-700'}`}>
                    {(selected.content as VocabItem).gender === 'm' ? '阳性' : '阴性'}
                  </span>
                  {(selected.content as VocabItem).plural && (selected.content as VocabItem).plural !== 'same' && (
                    <span className="text-xs text-gray-500">复数: {(selected.content as VocabItem).plural}</span>
                  )}
                </div>
                <div className="text-gray-700">{(selected.content as VocabItem).meaning}</div>
                <div className="text-sm text-gray-500">
                  例句：<PhoneticText segments={(selected.content as VocabItem).example.text} />
                </div>
                <div className="text-sm text-gray-400">{(selected.content as VocabItem).example.translation}</div>
              </div>
            )}

            {selected.type === 'grammar' && (
              <div className="bg-gray-50 rounded-2xl p-6 space-y-3">
                <div className="font-bold text-indigo-600 text-xl">{(selected.content as GrammarItem).point}</div>
                <div className="text-gray-700">{(selected.content as GrammarItem).explanation}</div>
                <div className="flex items-start gap-3 pt-2">
                  <PlayButton text={(selected.content as GrammarItem).example.text} size="sm" />
                  <div>
                    <PhoneticText segments={(selected.content as GrammarItem).example.text} className="text-lg font-medium text-gray-800" />
                    <div className="text-sm text-gray-500 mt-1">{(selected.content as GrammarItem).example.translation}</div>
                  </div>
                </div>
              </div>
            )}

            {selected.type === 'text' && (
              <div className="bg-gray-50 rounded-2xl p-6 space-y-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="text-xl font-bold text-gray-900 leading-8">
                    <PhoneticText segments={(selected.content as TextItem).text} />
                  </div>
                  <PlayButton text={(selected.content as TextItem).text} size="md" />
                </div>
                <div className="text-gray-600 border-t border-gray-200 pt-3">
                  {(selected.content as TextItem).translation}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

// 词典视图
const DictionaryView: React.FC<{ settings: AppSettings }> = ({ settings }) => {
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<VocabItem | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleSearch = async () => {
    if (!query) return;
    setLoading(true); setResult(null); setError("");
    try { const res = await AIService.generateDictionary(query, settings); setResult(res); } catch (e: any) { setError("查询失败，请检查网络或 Key"); } finally { setLoading(false); }
  };

  const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onloadend = async () => {
      const base64String = (reader.result as string).replace('data:', '').replace(/^.+,/, '');
      setLoading(true); setError(""); setResult(null);
      try { const res = await AIService.identifyImage(base64String, settings); setResult(res); } catch (err: any) { setError("图片识别失败: " + err.message); } finally { setLoading(false); }
    };
    reader.readAsDataURL(file);
  };

  return (
    <div className="max-w-2xl mx-auto pt-10 space-y-8 animate-in fade-in">
      <div className="text-center space-y-4">
        <h2 className="text-2xl font-bold text-gray-900">AI 多模态词典</h2>
        <div className="flex gap-2 bg-white p-2 rounded-2xl shadow-sm border border-gray-200">
          <input className="flex-1 px-4 outline-none" placeholder="输入法语单词..." value={query} onChange={e => setQuery(e.target.value)} onKeyDown={e => e.key === 'Enter' && handleSearch()} />
          <input type="file" ref={fileInputRef} className="hidden" accept="image/*" onChange={handleImageUpload} />
          <button onClick={() => fileInputRef.current?.click()} className="bg-gray-100 p-3 rounded-xl hover:bg-gray-200 text-gray-500"><Camera size={20} /></button>
          <button onClick={handleSearch} className="bg-indigo-600 text-white p-3 rounded-xl hover:bg-indigo-700">{loading ? <RefreshCw className="animate-spin" size={20} /> : <Search size={20} />}</button>
        </div>
        {error && <div className="text-red-500 text-sm">{error}</div>}
      </div>
      {result && (
        <div className="bg-white p-8 rounded-3xl shadow-xl border border-gray-100 space-y-6 animate-in slide-in-from-bottom-4">
          <div className="flex justify-between items-start">
            <div>
              <div className="flex items-center gap-2 mb-1">
                <span className="text-xs font-bold text-indigo-500 uppercase">{result.grammar_tag}</span>
                {result.gender && (
                  <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${result.gender === 'm' ? 'bg-blue-100 text-blue-700' : result.gender === 'f' ? 'bg-pink-100 text-pink-700' : 'bg-gray-100 text-gray-600'}`}>
                    {result.gender === 'm' ? '阳性' : result.gender === 'f' ? '阴性' : '-'}
                  </span>
                )}
              </div>
              <div className="text-4xl font-bold text-gray-900"><PhoneticText segments={result.word} /></div>
              {result.plural && result.plural !== 'same' && (
                <div className="text-sm text-gray-500 mt-1">复数: {result.plural}</div>
              )}
              <div className="text-xl text-gray-500 mt-1">{result.meaning}</div>
            </div>
            <PlayButton text={result.word} size="lg" />
          </div>
          <div className="bg-gray-50 p-6 rounded-2xl">
            <div className="flex gap-3 items-start"><PlayButton text={result.example.text} size="sm" />
              <div>
                <PhoneticText segments={result.example.text} className="text-lg text-gray-800" />
                <div className="text-gray-500 mt-1">{result.example.translation}</div>
              </div>
            </div>
            {result.example.grammar_point && <div className="mt-3 pt-3 border-t border-gray-200 text-sm text-gray-600"><span className="font-bold text-gray-400 uppercase text-xs">语法分析:</span> {result.example.grammar_point}</div>}
          </div>
        </div>
      )}
    </div>
  );
};


// 设置弹窗
const SettingsModal: React.FC<{ isOpen: boolean; onClose: () => void; onSave: (s: AppSettings) => void }> = ({ isOpen, onClose, onSave }) => {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);

  useEffect(() => {
    setSettings(LocalStorageManager.getSettings());
  }, [isOpen]);

  if (!isOpen) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm p-4 animate-in fade-in">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-100 flex justify-between items-center"><h3 className="font-bold text-lg text-gray-800 flex items-center gap-2"><Settings size={20} /> 系统设置</h3><button onClick={onClose}><X size={20} className="text-gray-400" /></button></div>
        <div className="p-6 space-y-6 h-[60vh] overflow-y-auto">
          <div><label className="block text-xs font-bold text-gray-400 uppercase mb-1">用户名</label><input value={settings.userName} onChange={e => setSettings({ ...settings, userName: e.target.value })} className="w-full px-3 py-2 border rounded-lg" /></div>

          <div>
            <label className="block text-xs font-bold text-gray-400 uppercase mb-2">文本生成模型 (AI Tutor)</label>
            <div className="grid grid-cols-2 gap-2">
              <button onClick={() => setSettings({ ...settings, selectedModel: 'gemini' })} className={`p-2 border rounded-lg text-sm font-bold ${settings.selectedModel === 'gemini' ? 'bg-indigo-50 border-indigo-500 text-indigo-700' : 'text-gray-500'}`}>⚡ Gemini Flash</button>
              <button onClick={() => setSettings({ ...settings, selectedModel: 'openai' })} className={`p-2 border rounded-lg text-sm font-bold ${settings.selectedModel === 'openai' ? 'bg-green-50 border-green-500 text-green-700' : 'text-gray-500'}`}>🧠 GPT-5.2</button>
            </div>
          </div>

          <div>
            <label className="block text-xs font-bold text-gray-400 uppercase mb-2">语音引擎 (TTS Provider)</label>
            <div className="space-y-2">
              <button onClick={() => setSettings({ ...settings, ttsProvider: 'browser' })} className={`w-full p-3 border rounded-xl text-left flex items-center justify-between ${settings.ttsProvider === 'browser' ? 'bg-gray-100 border-gray-400' : ''}`}>
                <span className="font-bold text-sm">浏览器默认 (免费)</span>
                {settings.ttsProvider === 'browser' && <CheckCircle size={16} className="text-gray-900" />}
              </button>
              <button onClick={() => setSettings({ ...settings, ttsProvider: 'google_cloud' })} className={`w-full p-3 border rounded-xl text-left flex items-center justify-between ${settings.ttsProvider === 'google_cloud' ? 'bg-blue-50 border-blue-500 text-blue-700' : ''}`}>
                <div><div className="font-bold text-sm">Google Cloud TTS</div><div className="text-xs opacity-70">Neural2 (自然音质)</div></div>
                {settings.ttsProvider === 'google_cloud' && <CheckCircle size={16} />}
              </button>
              <button onClick={() => setSettings({ ...settings, ttsProvider: 'openai' })} className={`w-full p-3 border rounded-xl text-left flex items-center justify-between ${settings.ttsProvider === 'openai' ? 'bg-green-50 border-green-500 text-green-700' : ''}`}>
                <div><div className="font-bold text-sm">OpenAI TTS</div><div className="text-xs opacity-70">TTS-1 (拟人情感)</div></div>
                {settings.ttsProvider === 'openai' && <CheckCircle size={16} />}
              </button>
            </div>
          </div>

          <div>
            <label className="block text-xs font-bold text-gray-400 uppercase mb-1">API 密钥配置</label>
            <div className="space-y-3">
              <input type="password" placeholder="Gemini API Key" value={settings.geminiKey} onChange={e => setSettings({ ...settings, geminiKey: e.target.value })} className="w-full px-3 py-2 border rounded-lg text-sm" />
              <input type="password" placeholder="OpenAI API Key (通用)" value={settings.openaiKey} onChange={e => setSettings({ ...settings, openaiKey: e.target.value })} className="w-full px-3 py-2 border rounded-lg text-sm" />
              {settings.ttsProvider === 'google_cloud' && (
                <div className="animate-in slide-in-from-top-2 fade-in">
                  <input type="password" placeholder="Google Cloud TTS API Key" value={settings.googleTTSKey} onChange={e => setSettings({ ...settings, googleTTSKey: e.target.value })} className="w-full px-3 py-2 border border-blue-200 bg-blue-50 rounded-lg text-sm text-blue-800 placeholder-blue-300" />
                  <p className="text-[10px] text-blue-500 mt-1">需在 Google Cloud Console 启用 Text-to-Speech API</p>
                </div>
              )}
            </div>
          </div>
        </div>
        <div className="p-4 bg-gray-50 flex justify-end"><button onClick={() => { DBAdapter.saveSettings(null, settings); onSave(settings); onClose(); }} className="bg-gray-900 text-white px-6 py-2 rounded-lg font-bold">保存</button></div>
      </div>
    </div>
  );
};

// 主应用组件
export default function FrancaisFlowSaaS() {
  const [user, setUser] = useState<FirebaseUser | null>(null);
  const [currentView, setCurrentView] = useState<'foundation' | 'course' | 'dict' | 'review'>('course');
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [showAuth, setShowAuth] = useState(false);
  const [showSettings, setShowSettings] = useState(false);

  // Lifted Course State
  const [courseTopic, setCourseTopic] = useState("");
  const [courseLoading, setCourseLoading] = useState(false);
  const [courseError, setCourseError] = useState("");
  const [generatedCourse, setGeneratedCourse] = useState<CourseData | null>(null);

  useEffect(() => {
    const initAuth = async () => {
      if (!auth) return;
      try {
        if (typeof __initial_auth_token !== 'undefined' && __initial_auth_token) {
          await signInWithCustomToken(auth, __initial_auth_token);
        }
      } catch (error) { console.warn("Auth warning", error); }
    };
    initAuth();
  }, []);

  useEffect(() => {
    if (auth) {
      return onAuthStateChanged(auth, async (u) => {
        setUser(u);
        const syncedSettings = await DBAdapter.loadSettings(u);
        setSettings(syncedSettings);
      });
    } else {
      setSettings(LocalStorageManager.getSettings());
    }
  }, []);

  return (
    <SettingsContext.Provider value={settings}>
      <div className="min-h-screen bg-[#F5F5F7] text-gray-800 font-sans">
        <header className="sticky top-0 bg-white/80 backdrop-blur-md border-b z-50 h-16 px-4 flex items-center justify-between">
          <div className="flex items-center gap-2 font-bold text-lg">
            <div className="bg-indigo-600 text-white p-1 rounded flex items-center justify-center w-8 h-8">
              <Type size={20} />
            </div>
            Français Flow Pro
          </div>
          <div className="flex items-center gap-4">
            {user ? (
              <div className="flex items-center gap-2 text-sm">
                <span className="text-green-600 flex items-center gap-1"><Cloud size={14} /> Synced</span>
                <span className="font-bold">{user.email?.split('@')[0]}</span>
                <button onClick={() => auth && signOut(auth)} className="text-gray-400 hover:text-red-500"><LogOut size={16} /></button>
              </div>
            ) : (
              <button onClick={() => setShowAuth(true)} className="flex items-center gap-2 text-sm font-bold bg-gray-100 px-3 py-1.5 rounded-full hover:bg-gray-200"><User size={16} /> 登录 / 注册</button>
            )}
            <button onClick={() => setShowSettings(true)} className="p-2 bg-gray-100 rounded-full hover:bg-gray-200"><Settings size={18} /></button>
          </div>
        </header>

        <main className="pt-8 px-4 max-w-4xl mx-auto pb-24">
          {currentView === 'foundation' && <FoundationView />}
          {currentView === 'course' && (
            <CourseGeneratorView
              settings={settings}
              user={user}
              topic={courseTopic}
              setTopic={setCourseTopic}
              loading={courseLoading}
              setLoading={setCourseLoading}
              errorMsg={courseError}
              setErrorMsg={setCourseError}
              course={generatedCourse}
              setCourse={setGeneratedCourse}
            />
          )}
          {currentView === 'review' && <ReviewCenterView user={user} />}
          {currentView === 'dict' && <DictionaryView settings={settings} />}
        </main>

        <nav className="fixed bottom-0 w-full bg-white border-t flex justify-around p-2 pb-safe z-40">
          {[
            { id: 'foundation', icon: Book, label: '基础' },
            { id: 'course', icon: GraduationCap, label: '课程' },
            { id: 'review', icon: Brain, label: '复习' },
            { id: 'dict', icon: Search, label: '词典' }
          ].map(item => (
            <button key={item.id} onClick={() => setCurrentView(item.id as any)} className={`flex flex-col items-center p-2 rounded-xl transition-all ${currentView === item.id ? 'text-indigo-600 scale-110' : 'text-gray-400'}`}>
              <item.icon size={24} strokeWidth={currentView === item.id ? 2.5 : 2} />
              <span className="text-[10px] font-bold mt-1">{item.label}</span>
            </button>
          ))}
        </nav>

        <AuthModal isOpen={showAuth} onClose={() => setShowAuth(false)} />
        <SettingsModal isOpen={showSettings} onClose={() => setShowSettings(false)} onSave={setSettings} />

        {!auth && (
          <div className="fixed bottom-24 left-4 right-4 bg-amber-50 border border-amber-200 p-4 rounded-xl text-sm text-amber-800 flex gap-3 shadow-lg z-50">
            <AlertTriangle className="shrink-0" />
            <div>
              <strong>Firebase 未配置</strong>
              <p>请在代码顶部的 firebaseConfig 中填入你的配置以启用云端同步。</p>
            </div>
          </div>
        )}
      </div>
    </SettingsContext.Provider>
  );
}

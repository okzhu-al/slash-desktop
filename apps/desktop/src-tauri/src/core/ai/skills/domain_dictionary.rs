//! Domain Dictionary Module
//!
//! Hardcoded knowledge domain classification for normalizing LLM folder names
//! Supports both Chinese and English keywords

/// Domain dictionary: (canonical domain name, keywords in both languages)
pub const DOMAIN_DICTIONARY: &[(&str, &[&str])] = &[
    // Humanities & Social Sciences
    (
        "政治",
        &[
            // Chinese
            "宪政",
            "民主",
            "选举",
            "政府",
            "政策",
            "政党",
            "自由主义",
            "社会主义",
            "共产",
            "资本主义",
            "极权",
            "独裁",
            "议会",
            "立法",
            // English
            "politic",
            "democracy",
            "election",
            "government",
            "policy",
            "liberal",
            "socialist",
            "communist",
            "capitalist",
            "authoritarian",
            "parliament",
        ],
    ),
    (
        "经济",
        &[
            // Chinese
            "货币",
            "财政",
            "市场",
            "金融",
            "贸易",
            "GDP",
            "通胀",
            "利率",
            "股票",
            "债券",
            "宏观",
            "微观",
            "供给",
            "需求",
            // English
            "econom",
            "monetary",
            "fiscal",
            "market",
            "finance",
            "trade",
            "inflation",
            "interest rate",
            "stock",
            "bond",
            "macro",
            "micro",
            "supply",
            "demand",
        ],
    ),
    (
        "哲学",
        &[
            // Chinese
            "唯心",
            "唯物",
            "存在主义",
            "本体论",
            "认识论",
            "伦理",
            "形而上",
            "现象学",
            "辩证法",
            "柏拉图",
            "康德",
            "黑格尔",
            // English
            "philosoph",
            "idealism",
            "materialism",
            "existential",
            "ontology",
            "epistemology",
            "ethics",
            "metaphysic",
            "phenomenology",
            "dialectic",
            "plato",
            "kant",
            "hegel",
            "nietzsche",
        ],
    ),
    (
        "心理",
        &[
            // Chinese
            "认知",
            "情绪",
            "行为",
            "潜意识",
            "人格",
            "焦虑",
            "抑郁",
            "心理学",
            "弗洛伊德",
            "荣格",
            "动机",
            "记忆",
            // English
            "psycholog",
            "cognitive",
            "emotion",
            "behavior",
            "subconscious",
            "personality",
            "anxiety",
            "depression",
            "freud",
            "jung",
            "motivation",
        ],
    ),
    (
        "历史",
        &[
            // Chinese
            "朝代",
            "战争",
            "革命",
            "文明",
            "帝国",
            "殖民",
            "古代",
            "近代",
            "现代",
            "考古",
            // English
            "histor",
            "dynasty",
            "war",
            "revolution",
            "civilization",
            "empire",
            "colonial",
            "ancient",
            "medieval",
            "modern",
            "archaeology",
        ],
    ),
    (
        "社会",
        &[
            // Chinese
            "社会学",
            "阶层",
            "文化",
            "族群",
            "社区",
            "公民",
            "人口",
            "城市化",
            "全球化",
            // English
            "sociolog",
            "class",
            "culture",
            "ethnic",
            "community",
            "citizen",
            "population",
            "urbanization",
            "globalization",
        ],
    ),
    (
        "法律",
        &[
            // Chinese
            "法治",
            "宪法",
            "刑法",
            "民法",
            "诉讼",
            "司法",
            "合同",
            "产权",
            // English
            "law",
            "legal",
            "constitution",
            "criminal",
            "civil",
            "court",
            "judicial",
            "contract",
            "property right",
            "litigation",
        ],
    ),
    (
        "逻辑",
        &[
            // Chinese
            "逻辑学",
            "推理",
            "演绎",
            "归纳",
            "谬误",
            "论证",
            "命题",
            "三段论",
            // English
            "logic",
            "reasoning",
            "deduction",
            "induction",
            "fallacy",
            "argument",
            "proposition",
            "syllogism",
        ],
    ),
    // Natural Sciences
    (
        "数学",
        &[
            // Chinese
            "代数",
            "几何",
            "微积分",
            "统计",
            "概率",
            "线性",
            "拓扑",
            "数论",
            // English
            "math",
            "algebra",
            "geometry",
            "calculus",
            "statistic",
            "probability",
            "linear",
            "topology",
            "number theory",
        ],
    ),
    (
        "物理",
        &[
            // Chinese
            "力学",
            "电磁",
            "量子",
            "相对论",
            "热力学",
            "光学",
            "粒子",
            // English
            "physic",
            "mechanic",
            "electromagnetic",
            "quantum",
            "relativity",
            "thermodynamic",
            "optic",
            "particle",
        ],
    ),
    (
        "化学",
        &[
            // Chinese
            "有机",
            "无机",
            "分子",
            "原子",
            "反应",
            "化合",
            "元素",
            // English
            "chemistr",
            "organic",
            "inorganic",
            "molecule",
            "atom",
            "reaction",
            "compound",
            "element",
        ],
    ),
    (
        "生物",
        &[
            // Chinese
            "细胞",
            "基因",
            "进化",
            "生态",
            "遗传",
            "生理",
            "解剖",
            // English
            "biolog",
            "cell",
            "gene",
            "evolution",
            "ecology",
            "genetic",
            "physiology",
            "anatomy",
        ],
    ),
    // Technology & Engineering
    (
        "科技",
        &[
            // Chinese
            "编程",
            "算法",
            "数据",
            "网络",
            "软件",
            "硬件",
            "互联网",
            "机器学习",
            "深度学习",
            // English
            "tech",
            "programming",
            "algorithm",
            "software",
            "hardware",
            "internet",
            "machine learning",
            "deep learning",
            "neural network",
            "AI",
            "LLM",
        ],
    ),
    (
        "工程",
        &[
            // Chinese
            "建筑",
            "机械",
            "电子",
            "土木",
            "航空",
            "制造",
            // English
            "engineer",
            "architecture",
            "mechanical",
            "electronic",
            "civil",
            "aerospace",
            "manufacturing",
        ],
    ),
    // Life Domains
    (
        "健康",
        &[
            // Chinese
            "运动",
            "饮食",
            "睡眠",
            "医疗",
            "疾病",
            "养生",
            "健身",
            "减肥",
            "营养",
            // English
            "health",
            "exercise",
            "diet",
            "sleep",
            "medical",
            "disease",
            "fitness",
            "nutrition",
            "workout",
        ],
    ),
    (
        "财务",
        &[
            // Chinese
            "理财",
            "储蓄",
            "保险",
            "税务",
            "资产",
            "负债",
            "预算",
            "记账",
            // English
            "finance",
            "saving",
            "insurance",
            "tax",
            "asset",
            "liability",
            "budget",
            "accounting",
            "invest",
        ],
    ),
    (
        "职业",
        &[
            // Chinese
            "工作",
            "求职",
            "简历",
            "面试",
            "晋升",
            "技能",
            "职场",
            "创业",
            // English
            "career",
            "job",
            "resume",
            "interview",
            "promotion",
            "skill",
            "workplace",
            "startup",
            "entrepreneur",
        ],
    ),
    (
        "教育",
        &[
            // Chinese
            "学习",
            "考试",
            "课程",
            "培训",
            "阅读",
            "笔记",
            "教学",
            // English
            "education",
            "learning",
            "exam",
            "course",
            "training",
            "reading",
            "teaching",
            "study",
        ],
    ),
    (
        "艺术",
        &[
            // Chinese
            "绘画",
            "音乐",
            "电影",
            "文学",
            "设计",
            "摄影",
            "雕塑",
            "舞蹈",
            // English
            "art",
            "painting",
            "music",
            "film",
            "movie",
            "literature",
            "design",
            "photography",
            "sculpture",
            "dance",
        ],
    ),
    (
        "语言",
        &[
            // Chinese
            "英语",
            "日语",
            "语法",
            "词汇",
            "翻译",
            "写作",
            "口语",
            // English
            "language",
            "english",
            "japanese",
            "grammar",
            "vocabulary",
            "translation",
            "writing",
            "speaking",
            "linguistic",
        ],
    ),
    // Additional Domains
    (
        "宗教",
        &[
            // Chinese
            "佛教",
            "基督教",
            "伊斯兰",
            "道教",
            "信仰",
            "神学",
            "祈祷",
            "经文",
            "寺庙",
            "教堂",
            // English
            "religio",
            "buddhis",
            "christian",
            "islam",
            "faith",
            "theology",
            "prayer",
            "temple",
            "church",
        ],
    ),
    (
        "军事",
        &[
            // Chinese
            "战争", "军队", "武器", "战略", "国防", "部队", "作战", "军事",
            // English
            "militar", "war", "army", "weapon", "defense", "strategy", "combat", "troop",
        ],
    ),
    (
        "地理",
        &[
            // Chinese
            "地理",
            "地图",
            "气候",
            "地形",
            "人口",
            "城市",
            "区域",
            "环境",
            // English
            "geograph",
            "map",
            "climate",
            "terrain",
            "population",
            "urban",
            "region",
        ],
    ),
    (
        "农业",
        &[
            // Chinese
            "农业",
            "种植",
            "养殖",
            "农作物",
            "畜牧",
            "农村",
            "土壤",
            // English
            "agricultur",
            "farming",
            "crop",
            "livestock",
            "rural",
            "soil",
            "harvest",
        ],
    ),
    (
        "传媒",
        &[
            // Chinese
            "新闻",
            "媒体",
            "记者",
            "报道",
            "广告",
            "公关",
            "舆论",
            // English
            "media",
            "news",
            "journal",
            "broadcast",
            "advertis",
            "public relation",
        ],
    ),
    (
        "体育",
        &[
            // Chinese
            "运动",
            "足球",
            "篮球",
            "游泳",
            "健身",
            "比赛",
            "奥运",
            // English
            "sport",
            "football",
            "basketball",
            "swimming",
            "fitness",
            "olympic",
            "athlet",
        ],
    ),
    (
        "建筑",
        &[
            // Chinese
            "建筑",
            "设计",
            "施工",
            "结构",
            "规划",
            "房屋",
            "装修",
            // English
            "architect",
            "building",
            "construction",
            "structure",
            "planning",
        ],
    ),
    (
        "环保",
        &[
            // Chinese
            "环保",
            "生态",
            "污染",
            "可持续",
            "碳排放",
            "绿色",
            "节能",
            // English
            "environment",
            "ecology",
            "pollution",
            "sustainable",
            "carbon",
            "green energy",
        ],
    ),
];

/// Normalize domain name by matching against dictionary
///
/// Strategy:
/// 1. Exact match: input is a domain name
/// 2. Keyword match: input contains a keyword (case-insensitive for English)
/// 3. No match: return None
#[allow(dead_code)]
pub fn normalize_domain(input: &str) -> Option<&'static str> {
    let input_lower = input.to_lowercase();

    // 1. Exact match domain name
    for (domain, _) in DOMAIN_DICTIONARY {
        if input_lower == domain.to_lowercase() {
            return Some(domain);
        }
    }

    // 2. Keyword match (case-insensitive)
    for (domain, keywords) in DOMAIN_DICTIONARY {
        for keyword in *keywords {
            // Case-insensitive match for English keywords
            if input_lower.contains(&keyword.to_lowercase()) {
                return Some(domain);
            }
        }
    }

    // 3. No match
    None
}

/// Get all domain names (for LLM prompt)
pub fn get_domain_list() -> Vec<&'static str> {
    DOMAIN_DICTIONARY
        .iter()
        .map(|(domain, _)| *domain)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_exact_match() {
        assert_eq!(normalize_domain("政治"), Some("政治"));
        assert_eq!(normalize_domain("哲学"), Some("哲学"));
    }

    #[test]
    fn test_chinese_keyword_match() {
        assert_eq!(normalize_domain("宪政民主"), Some("政治"));
        assert_eq!(normalize_domain("唯心主义"), Some("哲学"));
        assert_eq!(normalize_domain("货币政策"), Some("经济"));
    }

    #[test]
    fn test_english_keyword_match() {
        assert_eq!(normalize_domain("Democracy"), Some("政治"));
        assert_eq!(normalize_domain("Philosophy"), Some("哲学"));
        assert_eq!(normalize_domain("Economics"), Some("经济"));
        assert_eq!(normalize_domain("machine learning"), Some("科技"));
    }

    #[test]
    fn test_no_match() {
        assert_eq!(normalize_domain("随机内容"), None);
        assert_eq!(normalize_domain("random stuff"), None);
    }
}

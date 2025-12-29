export const guessLanguages = (name: string, category?: string) => {
  const languages = new Set<string>();
  if (category?.includes("HU")) languages.add("🇭🇺 HUN");
  if (category?.includes("EN")) languages.add("🇬🇧 ENG");

 const languageMap: Record<string, { flag: string; code: string }> = {
    hun: { flag: "🇭🇺", code: "HUN" },
    hungarian: { flag:  "🇭🇺", code: "HUN" },
    ger: { flag:  "🇩🇪", code: "GER" },
    german: { flag:  "🇩🇪", code: "GER" },
    fre: { flag:  "🇫🇷", code: "FRE" },
    french: { flag:  "🇫🇷", code: "FRE" },
    ita: { flag:  "🇮🇹", code: "ITA" },
    italian: { flag:  "🇮🇹", code: "ITA" },
    eng: { flag:  "🇬🇧", code: "ENG" },
    english: { flag:  "🇬🇧", code: "ENG" },
    rus: { flag:  "🇷🇺", code: "RUS" },
    russian: { flag:  "🇷🇺", code: "RUS" },
    spa: { flag:  "🇪🇸", code: "SPA" },
    spanish: { flag:  "🇪🇸", code: "SPA" },
    multi: { flag:  "🌍", code: "MULTI" },
  };

  const regex = new RegExp(Object.keys(languageMap).join("|"), "gi");
  const matches = name.toLowerCase().match(regex);

  if (matches) {
   matches.forEach((match) =>{
    const lang = languageMap[match.toLowerCase()];
    if (lang) languages.add(`${lang.flag} ${lang.code}`);
    });
  } 
  if (languages.size === 0) {
    languages.add("❓ Ismeretlen");
  }

  return [...languages].join(" / ");
};

declare module "snowball-stemmers" {
  interface Stemmer {
    stem(word: string): string;
  }
  const snowball: {
    newStemmer(language: string): Stemmer;
    algorithms(): string[];
  };
  export default snowball;
}

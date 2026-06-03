import { RNG } from "./rng";

const US_FIRST = [
  "Jacob", "Michael", "Joshua", "Matthew", "Daniel", "Christopher", "Andrew", "Tyler",
  "Brandon", "Justin", "Cody", "Nicholas", "Anthony", "Zachary", "Kyle", "Austin",
  "Dustin", "Cole", "Hunter", "Caleb", "Ethan", "Logan", "Mason", "Garrett",
  "Devin", "Trevor", "Marcus", "Brett", "Shane", "Wyatt", "Travis", "Derek",
  "Jared", "Aaron", "Sean", "Ryan", "Evan", "Colton", "Dakota", "Levi",
];

const US_LAST = [
  "Rodriguez", "Mendoza", "O'Neill", "Vandenberg", "Calderón", "Mace", "Hicks",
  "Boyle", "Restrepo", "Murphy", "Gallagher", "Vimoto", "Pemble", "Buno", "Cortez",
  "Donoho", "Cunningham", "Larson", "Olson", "Whitaker", "Fields", "Doyle", "Brennan",
  "Salazar", "Nguyen", "Patterson", "Reyes", "Holloway", "Beckett", "Marsh", "Tucker",
  "Carrillo", "Kowalski", "Petersen", "Ramos", "Sutton", "Ayers", "Granados", "Hollis",
  "Sapporo", "Knight", "Vargas", "Brewer", "Linder", "Toner", "Pratt", "Mercer",
];

const US_NICK = [
  "Doc", "Sarge", "Tex", "Cowboy", "Reaper", "Ghost", "Spider", "Maddog", "Lurch",
  "Six", "Tiny", "Hammer", "Preacher", "Scrappy", "Lobo", "Rooster", "Bones", "Whiskey",
];

const PASHTUN_FIRST = [
  "Abdul", "Mohammad", "Ahmad", "Gul", "Rahim", "Habib", "Daoud", "Najib", "Wali",
  "Zia", "Noor", "Asadullah", "Hekmat", "Sher", "Janan", "Baz", "Sharif", "Karim",
  "Rashid", "Sultan", "Mirwais", "Bismillah", "Hayatullah", "Fazel", "Roohullah",
  "Saifullah", "Khan", "Amir", "Nasrullah", "Qari", "Mullah", "Haji",
];

const PASHTUN_LAST = [
  "Khan", "Wazir", "Safi", "Korangali", "Mangal", "Zazai", "Achakzai", "Stanikzai",
  "Hotak", "Ghilzai", "Durrani", "Popalzai", "Kakar", "Yousafzai", "Afridi", "Mohmand",
  "Shinwari", "Tani", "Zadran", "Kuchi", "Nuristani", "Pashai",
];

const ELDER_TITLE = ["Malik", "Haji", "Mawlawi", "Qari", "Mullah", "Wakil"];

export function usName(rng: RNG): { first: string; last: string; full: string } {
  const first = rng.pick(US_FIRST);
  const last = rng.pick(US_LAST);
  return { first, last, full: `${first} ${last}` };
}

export function usNickname(rng: RNG): string {
  return rng.pick(US_NICK);
}

export function pashtunName(rng: RNG): string {
  const first = rng.pick(PASHTUN_FIRST);
  // Pashtun names often pair two given names or a given name + tribe.
  if (rng.chance(0.45)) return `${first} ${rng.pick(PASHTUN_FIRST)}`;
  return `${first} ${rng.pick(PASHTUN_LAST)}`;
}

export function elderName(rng: RNG): string {
  return `${rng.pick(ELDER_TITLE)} ${rng.pick(PASHTUN_FIRST)} ${rng.pick(PASHTUN_LAST)}`;
}

const US_CALLSIGNS = [
  "Chosen", "Battle", "Destined", "Viper", "Outlaw", "Reaper", "Dagger", "Havoc",
  "Gator", "Lightning", "Renegade", "Cutthroat", "Wrecker", "Saber",
];

export function companyCallsign(rng: RNG): string {
  return rng.pick(US_CALLSIGNS);
}

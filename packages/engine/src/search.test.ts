import { memorySearch } from "./search";
import { searchContract } from "./search-contract";

searchContract("memory", (world) => memorySearch(world));

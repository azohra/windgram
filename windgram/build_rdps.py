"""Entry point: builds windgram profiles from the latest RDPS 10 km run."""

from .build import RDPS, run

if __name__ == "__main__":
    run(RDPS)

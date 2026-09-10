Apple M1 Pro, 10 cores, node v26.8.1
100,000 accounts, 7,184,820 trades stored, 3,955,749 read before a verdict, median of 21 passes
cost assumes $0.036 per vCPU-hour

| engine                                      | threads | wall      | accounts/sec | trades/sec    | CPU s per 1M | $ per 1B | peak RSS |
|---------------------------------------------|---------|-----------|--------------|---------------|--------------|----------|----------|
| node idiomatic (JSON in, objects per trade) | 1       | 1647.7 ms | 60,692       | 2,400,819     | 16.477       | $0.1648  | 243 MB   |
| node tuned (binary buffer, no allocation)   | 1       | 20.6 ms   | 4,865,923    | 192,483,715   | 0.206        | $0.0021  | 297 MB   |
| node tuned + worker_threads                 | 10      | 3.0 ms    | 33,231,788   | 1,314,566,124 | 0.301        | $0.0030  | 559 MB   |
| rust single thread                          | 1       | 10.1 ms   | 9,931,678    | 392,872,253   | 0.101        | $0.0010  | 113 MB   |
| rust + rayon                                | 10      | 1.6 ms    | 63,658,789   | 2,518,181,905 | 0.157        | $0.0016  | 113 MB   |

| engine                                      | unit          | p50      | p99      |
|---------------------------------------------|---------------|----------|----------|
| node idiomatic (JSON in, objects per trade) | 1 account     | 15 us    | 26.1 us  |
| node tuned (binary buffer, no allocation)   | 1000 accounts | 220.8 us | 349.4 us |
| rust single thread                          | 1000 accounts | 101.3 us | 126.7 us |

all engines agree, checksum 33984963, 3,955,749 trades read

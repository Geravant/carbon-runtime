# Running the spike page where there is no GPU

What M1 used to answer "does the engine render on the test server" (a Linux machine with no GPU, Chromium on SwiftShader in a container). The image has the same base and Chromium package as the game's stand image.

```sh
# on this machine: stage the built page (after tools/build-effects.mjs and tools/build-page.mjs)
S=$(mktemp -d) && mkdir $S/tools
cp -R ../../index.html ../../dist ../../data ../../res $S/ && cp ../shoot.mjs probe-*.mjs $S/tools/ && cp Dockerfile package.json $S/
rsync -az $S/ <box>:/opt/carbon-m1/

# on the box
cd /opt/carbon-m1 && docker build -q -t carbon-m1:probe . && mkdir -p out && chmod 777 out
R="docker run --rm --network none --memory 2g --cpus 2 --shm-size 256m -v $PWD/out:/app/shots carbon-m1:probe node tools/shoot.mjs --executable /usr/bin/chromium --strict --wait 60000"
$R --gpu swiftshader --backend webgl2 --out box --probe      # WebGL2 on SwiftShader
$R --gpu swiftshader --backend webgpu --out box --probe      # WebGPU on SwiftShader
$R --gpu stand --backend webgl2 --out box --probe            # exactly the stand wrapper's flags
docker run --rm --network none carbon-m1:probe node tools/probe-webgpu.mjs     # which flag sets give a living device
docker run --rm --network none carbon-m1:probe node tools/probe-present.mjs    # which of those present the canvas
```

Results of the M1 run are in `../../shots/m1/box/` and in the port docs (`05-fork-changes.md`).

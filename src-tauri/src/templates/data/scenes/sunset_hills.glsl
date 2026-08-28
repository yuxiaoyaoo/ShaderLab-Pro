void mainImage(out vec4 fragColor, in vec2 fragCoord)
{
    vec2 uv = (fragCoord - 0.5 * iResolution.xy) / iResolution.y;

    vec3 zen = vec3(0.17, 0.10, 0.33);
    vec3 hor = vec3(1.00, 0.55, 0.25);
    float skyMix = smoothstep(-0.25, 0.65, uv.y);
    vec3 col = mix(hor, zen, skyMix);

    float sunT = iTime * 0.05;
    vec2 sunPos = vec2(sin(sunT) * 0.55, -0.18 + 0.06 * cos(sunT));
    float sd = length(uv - sunPos);
    float disc = 1.0 - smoothstep(0.055, 0.075, sd);
    float halo = exp(-sd * sd * 9.0);
    col += vec3(1.00, 0.85, 0.55) * halo * 0.55;
    col = mix(col, vec3(1.00, 0.95, 0.80), disc);

    float cloudN = uv.x * 2.0 - iTime * 0.03;
    float bandMask = smoothstep(0.30, 0.75, uv.y) * (1.0 - smoothstep(0.75, 0.95, uv.y));
    float streak = 0.5 + 0.5 * sin(cloudN * 9.0 + 2.0 * sin(cloudN * 3.7));
    col += vec3(0.95, 0.45, 0.30) * streak * bandMask * 0.12;

    vec4 ridgeCols[4];
    ridgeCols[0] = vec4(0.66, 0.36, 0.42, 0.55);
    ridgeCols[1] = vec4(0.48, 0.24, 0.38, 0.35);
    ridgeCols[2] = vec4(0.30, 0.15, 0.32, 0.18);
    ridgeCols[3] = vec4(0.16, 0.09, 0.24, 0.05);

    float bases[4];
    bases[0] = -0.08; bases[1] = -0.16; bases[2] = -0.24; bases[3] = -0.34;

    for (int i = 0; i < 4; i++)
    {
        float fi = float(i);
        float xo = iTime * (0.008 + 0.012 * fi);
        float xr = uv.x * (1.0 + fi * 0.7) + xo + fi * 7.7;

        float ry = bases[i]
                 + (0.055 * sin(xr * 2.3 + fi * 1.1)
                 + 0.035 * sin(xr * 5.1 + fi * 3.3)
                 + 0.020 * sin(xr * 11.7 + fi * 5.9)) * (1.0 + fi * 0.25);

        float below = 1.0 - smoothstep(ry, ry + 0.004, uv.y);
        vec3 rc = mix(ridgeCols[i].rgb, hor, ridgeCols[i].a);
        col = mix(col, rc, below);
    }

    col *= 1.0 - 0.22 * dot(uv, uv);

    fragColor = vec4(col, 1.0);
}

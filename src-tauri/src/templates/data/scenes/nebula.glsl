float hash21(vec2 p)
{
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
}

float noise(vec2 p)
{
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float a = hash21(i);
    float b = hash21(i + vec2(1.0, 0.0));
    float c = hash21(i + vec2(0.0, 1.0));
    float d = hash21(i + vec2(1.0, 1.0));
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

float fbm(vec2 p)
{
    float v = 0.0;
    float a = 0.5;
    mat2 r = mat2(0.8, -0.6, 0.6, 0.8);
    for (int i = 0; i < 5; i++)
    {
        v += a * noise(p);
        p = r * p * 2.03;
        a *= 0.5;
    }
    return v;
}

void mainImage(out vec4 fragColor, in vec2 fragCoord)
{
    vec2 uv = (fragCoord - 0.5 * iResolution.xy) / iResolution.y;

    float rotA = iTime * 0.02;
    mat2 rotM = mat2(cos(rotA), -sin(rotA), sin(rotA), cos(rotA));
    vec2 p = rotM * uv * 1.6;

    float warp = fbm(p * 1.1 + vec2(iTime * 0.015, -iTime * 0.010));
    float dens = fbm(p * 1.3 + warp * 1.5 + 4.7);
    dens = pow(clamp(dens, 0.0, 1.0), 2.0);

    float edges = fbm(p * 0.9 - vec2(iTime * 0.010, iTime * 0.013) + 2.7);

    vec3 neb = mix(vec3(0.10, 0.05, 0.30), vec3(0.55, 0.20, 0.60), dens);
    neb = mix(neb, vec3(0.90, 0.65, 0.85), pow(dens, 3.0) * 0.8);
    neb += vec3(0.05, 0.35, 0.40) * pow(max(edges - 0.35, 0.0) / 0.65, 2.5) * 0.7;

    vec3 col = neb * (0.35 + 1.1 * dens);

    vec2 sq = uv * 42.0;
    vec2 sid = floor(sq);
    vec2 sf = fract(sq) - 0.5;
    float sh = hash21(sid);
    if (sh > 0.986)
    {
        vec2 soff = vec2(hash21(sid + 1.3), hash21(sid + 2.6)) - 0.5;
        float sd2 = length(sf - soff * 0.7);
        float twk = 0.60 + 0.40 * sin(iTime * (1.5 + 3.0 * fract(sh * 77.0)) + sh * 91.0);
        float starDot = 1.0 - smoothstep(0.02, 0.09, sd2);
        col += vec3(0.9, 0.92, 1.0) * starDot * twk * 1.1;
    }

    col *= 1.0 - 0.30 * dot(uv, uv);

    fragColor = vec4(col, 1.0);
}

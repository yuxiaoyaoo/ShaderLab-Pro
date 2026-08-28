vec3 lensScene(vec2 p)
{
    vec3 col = mix(vec3(0.055, 0.065, 0.095), vec3(0.115, 0.135, 0.195), 0.5 + 0.5 * p.y);

    vec2 g = abs(fract(p * 5.0) - 0.5);
    float line = smoothstep(0.44, 0.5, max(g.x, g.y));
    col += vec3(0.35, 0.70, 0.90) * line * 0.5;

    float r = length(p);
    float band = smoothstep(0.42, 0.5, abs(fract(r * 4.0) - 0.5));
    col += vec3(0.85, 0.35, 0.60) * band * 0.22;

    vec2 orb = 0.30 * vec2(cos(iTime * 1.1), sin(iTime * 1.4));
    float dl = length(p - orb);
    col += vec3(1.0, 0.9, 0.55) * exp(-dl * dl * 850.0) * 0.85;

    return col;
}

void mainImage(out vec4 fragColor, in vec2 fragCoord)
{
    vec2 uv = (fragCoord - 0.5 * iResolution.xy) / iResolution.y;

    float r = length(uv);
    vec2 dirU = uv / max(r, 1e-4);

    float k = 0.55 + 0.18 * sin(iTime * 0.4);
    float beta = 1.0 - k * 0.55;
    float scale = 0.76;

    float off = 0.012 * smoothstep(0.15, 0.62, r);

    vec2 spC = dirU * pow(max(r, 1e-4), beta) * scale;
    vec2 spR = dirU * pow(clamp(r + off, 1e-4, 1.5), beta) * scale;
    vec2 spB = dirU * pow(clamp(max(r - off, 1e-4), 1e-4, 1.5), beta) * scale;

    vec3 col;
    col.g = lensScene(spC).g;
    col.r = lensScene(spR).r;
    col.b = lensScene(spB).b;

    float lensMask = smoothstep(0.492, 0.468, r);
    vec3 frame = vec3(0.024, 0.028, 0.04);
    col = mix(frame, col, lensMask);
    col += vec3(0.25, 0.5, 0.7) * smoothstep(0.465, 0.488, r) * (1.0 - smoothstep(0.488, 0.498, r)) * 0.5;

    fragColor = vec4(col, 1.0);
}

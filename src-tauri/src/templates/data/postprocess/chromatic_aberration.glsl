float lattice(vec2 uv)
{
    vec2 g = fract(uv * vec2(9.0, 6.0)) - 0.5;
    float lx = 1.0 - smoothstep(0.05, 0.09, abs(g.x));
    float ly = 1.0 - smoothstep(0.05, 0.09, abs(g.y));
    return max(lx, ly);
}

void mainImage(out vec4 fragColor, in vec2 fragCoord)
{
    vec2 uv = (fragCoord - 0.5 * iResolution.xy) / iResolution.y;

    float r = length(uv);
    vec2 dir = normalize(uv + vec2(0.0001));
    float shift = r * r * 0.045;

    float chanR = lattice(uv - dir * shift);
    float chanG = lattice(uv);
    float chanB = lattice(uv + dir * shift);

    vec3 col = vec3(chanR, chanG, chanB) * 0.92 + vec3(0.04, 0.05, 0.09);

    col += vec3(1.0) * (1.0 - smoothstep(0.000, 0.003, abs(uv.x))) * 0.30;

    col *= 1.0 - 0.18 * r * r;

    fragColor = vec4(col, 1.0);
}
